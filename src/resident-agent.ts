import type { ManagedAgentProvider } from "./agent-runtime.js";
import { classifyBlockingText, runPlainClaude } from "./blocking-conditions.js";
import { NativeTranscriptUnavailableError, readClaudeTranscriptTail, type ClaudeTranscriptTail } from "./native-transcript.js";

/** A long-lived agent session that is already running; the host never names provider mechanics. */
export interface ResidentAgentTarget {
  provider: ManagedAgentProvider;
  /** Native conversation/session ID of the running resident. */
  sessionId: string;
  cwd: string;
}

export interface ResidentMessageOptions {
  /** How long to wait for the resident to finish its turn after delivery is confirmed. */
  replyTimeoutMs?: number;
}

export type ResidentMessageResult =
  /** Delivered to the same running session and its turn finished. */
  | { status: "replied"; reply: string }
  /** Delivered to the same running session; the turn had not finished before the timeout. */
  | { status: "reply-pending"; reply: string };

export type ResidentMessageRefusalReason =
  | "unsupported-provider" | "invalid-message" | "not-running" | "busy" | "blocked" | "delivery-unconfirmed";

/** Nothing here ever falls back to a new, resumed, or forked session. */
export class ResidentMessageRefusal extends Error {
  readonly reason: ResidentMessageRefusalReason;
  constructor(reason: ResidentMessageRefusalReason, message: string) {
    super(message);
    this.name = "ResidentMessageRefusal";
    this.reason = reason;
  }
}

export interface ResidentAgentMessenger {
  message(target: ResidentAgentTarget, text: string, options?: ResidentMessageOptions): Promise<ResidentMessageResult>;
}

export interface ClaudeBackgroundListing { id: string; sessionId: string; cwd: string; status?: string }

export interface ResidentTerminal {
  write(data: string): void;
  /** Milliseconds since epoch of the latest terminal output, or undefined before any. */
  lastOutputAt(): number | undefined;
  /** Resolves when the attach client exits on its own. */
  exited: Promise<number>;
  /** Detach only: stops the attach client, never the resident session. */
  close(): Promise<void>;
}

export interface ClaudeResidentDeps {
  listBackground(): Promise<ClaudeBackgroundListing[]>;
  openAttach(shortId: string, cwd: string): ResidentTerminal;
  /** The session's current screen (`claude logs`), read only when its listing reports no status. */
  readScreen(shortId: string): Promise<string>;
  readTail(target: ResidentAgentTarget, offset: number): Promise<ClaudeTranscriptTail>;
  now(): number;
  sleep(ms: number): Promise<void>;
  attachReadyTimeoutMs: number;
  deliveryTimeoutMs: number;
  pollMs: number;
}

export const RESIDENT_MESSAGE_MAX_CHARS = 16_000;
const DEFAULT_REPLY_TIMEOUT_MS = 5 * 60_000;
const ATTACH_QUIET_MS = 800;

export async function listClaudeBackgroundSessions(): Promise<ClaudeBackgroundListing[]> {
  let stdout: string;
  let exitCode: number;
  try {
    const child = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  } catch {
    throw new Error("Claude background session listing could not run");
  }
  if (exitCode !== 0) throw new Error("Claude background session listing exited unsuccessfully");
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error("Claude background session listing returned invalid JSON"); }
  if (!Array.isArray(value)) throw new Error("Claude background session listing was not an array");
  return value.flatMap((entry: any) => entry?.kind === "background" && typeof entry.id === "string"
    && typeof entry.sessionId === "string" && typeof entry.cwd === "string"
    ? [{ id: entry.id, sessionId: entry.sessionId, cwd: entry.cwd, ...(typeof entry.status === "string" ? { status: entry.status } : {}) }]
    : []);
}

export function openClaudeAttach(shortId: string, cwd: string): ResidentTerminal {
  let last: number | undefined;
  const child = Bun.spawn(["claude", "attach", shortId], {
    cwd, terminal: { cols: 160, rows: 50, data() { last = Date.now(); } },
  });
  return {
    write: data => { child.terminal!.write(data); },
    lastOutputAt: () => last,
    exited: child.exited,
    close: async () => {
      child.kill();
      await child.exited;
      child.terminal!.close();
    },
  };
}

function validMessage(text: string): string {
  const trimmed = text.trim();
  // Newlines and tabs survive a bracketed paste; other controls could end the paste or drive the TUI.
  if (!trimmed || trimmed.length > RESIDENT_MESSAGE_MAX_CHARS || /[\0-\x08\x0b-\x1f\x7f]/.test(trimmed)) {
    throw new ResidentMessageRefusal("invalid-message",
      `Resident messages must be 1-${RESIDENT_MESSAGE_MAX_CHARS} characters without control characters other than newline and tab`);
  }
  return trimmed;
}

function records(text: string): any[] {
  return text.split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { throw new Error("Resident transcript contains an invalid JSON record"); }
  });
}

function userText(record: any): string | undefined {
  if (record?.type !== "user" || record.isSidechain || record.message?.role !== "user") return undefined;
  const content = record.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") return content[0].text;
  return undefined;
}

/**
 * Measured on rocketr's resident (session 517fd13a, 2026-09-18): Claude Code
 * records a long bracketed paste not as the pasted text but wrapped whole, as
 * `\n\n<pasted_content id="a3f4">\n…\n</pasted_content id="a3f4">\n`. A
 * delivered message is the record's text, or exactly one such block around it
 * and nothing else, so a turn that merely quotes a paste never counts.
 */
const PASTED_CONTENT = /^\s*<pasted_content id="([^"]+)">\n([\s\S]*)\n<\/pasted_content(?: id="\1")?>\s*$/;

function deliveredText(record: any): string | undefined {
  const text = userText(record);
  if (text === undefined) return undefined;
  return PASTED_CONTENT.exec(text)?.[2] ?? text;
}

/**
 * What a listed Claude session is doing, read from its listing and transcript:
 * - `idle`: listed idle, or listed with no status (never prompted; the caller
 *   checks its screen for a blocking prompt).
 * - `background`: listed busy only because background workers (a Monitor, a
 *   background shell) keep running while the session waits at its prompt.
 * - `turn`: mid-turn; typed input would queue behind unknown work.
 *
 * Measured 2026-09-18: `claude agents --json` lists a session `busy` for as
 * long as any Monitor runs. lead-dynamic-atmosphere listed busy/working while
 * its last conversation record was the `turn_duration` that closed its turn
 * sixteen minutes earlier. herdr's screen detection already calls such a pane
 * `done`; this is the same judgement for the listing. A turn is ended only
 * when the last main-thread conversation record is `turn_duration`, so a turn
 * cut off without one reads as `turn`, the safe side.
 */
export type ClaudeResidentActivity = "idle" | "background" | "turn";

export function claudeResidentActivity(status: string | undefined, transcript: string): ClaudeResidentActivity {
  if (status === undefined || status === "idle") return "idle";
  const conversation = records(transcript).filter(record => !record?.isSidechain
    && (record?.type === "user" || record?.type === "assistant" || (record?.type === "system" && record.subtype === "turn_duration")));
  const last = conversation[conversation.length - 1];
  return last?.type === "system" ? "background" : "turn";
}

/**
 * Claude Code has no machine API for a running background session: `claude -p --resume <id>`
 * refuses while it runs and `--fork-session` is a different session. Its documented
 * `claude attach` terminal is the only path to the same process, so delivery is typed there
 * and proven only by the session's own transcript. The reply is read from that transcript.
 */
export class ClaudeResidentMessenger implements ResidentAgentMessenger {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly deps: ClaudeResidentDeps;

  constructor(deps: Partial<ClaudeResidentDeps> = {}) {
    this.deps = {
      listBackground: listClaudeBackgroundSessions,
      openAttach: openClaudeAttach,
      readScreen: async shortId => (await runPlainClaude(["logs", shortId])).stdout,
      readTail: (target, offset) => readClaudeTranscriptTail({ sessionId: target.sessionId, cwd: target.cwd }, offset),
      now: Date.now,
      sleep: ms => Bun.sleep(ms),
      attachReadyTimeoutMs: 15_000,
      deliveryTimeoutMs: 30_000,
      pollMs: 250,
      ...deps,
    };
  }

  message(target: ResidentAgentTarget, text: string, options: ResidentMessageOptions = {}): Promise<ResidentMessageResult> {
    const pending = this.queue.catch(() => {}).then(() => this.messageNow(target, text, options));
    this.queue = pending;
    return pending;
  }

  private async messageNow(target: ResidentAgentTarget, text: string, options: ResidentMessageOptions): Promise<ResidentMessageResult> {
    if (target.provider !== "claude") throw new ResidentMessageRefusal("unsupported-provider", "This messenger only serves Claude residents");
    const message = validMessage(text);
    const { deps } = this;
    // The session ID is a UUID, so it alone names the session. The listing's
    // cwd is where the session is now: a resident that entered a worktree is
    // listed there, and the host's launch directory is no longer its own.
    const live = (await deps.listBackground()).find(entry => entry.sessionId === target.sessionId);
    // Attaching an absent job wakes it, so absence is refused rather than attached.
    if (!live) throw new ResidentMessageRefusal("not-running", "The resident's exact session is not a running background session");
    if (live.status === undefined) {
      // Measured: a never-prompted session lists with no status at all, and so
      // does one stuck on a startup prompt, where a typed Enter would answer it.
      // Only the screen tells them apart.
      const blocking = classifyBlockingText("claude", await deps.readScreen(live.id));
      if (blocking) throw new ResidentMessageRefusal("blocked", `The resident is stopped on a prompt, not idle: ${blocking.detail}`);
    }
    target = { ...target, cwd: live.cwd };

    const first = await deps.readTail(target, 0);
    let offset = first.offset;
    let history = first.text;
    for (let tail = await deps.readTail(target, offset); tail.offset !== offset; tail = await deps.readTail(target, offset)) {
      offset = tail.offset;
      history += tail.text;
    }
    if (claudeResidentActivity(live.status, history) === "turn") {
      throw new ResidentMessageRefusal("busy", "The resident is mid-turn; typed input would queue behind unknown work");
    }

    // The session can change directory mid-turn (entering a git worktree is
    // the observed case), and Claude Code then carries its transcript to the
    // new directory's project folder. Reads follow it: see `readFollowing`.
    let current = target;
    const read = async (at: number): Promise<ClaudeTranscriptTail> => {
      const followed = await this.readFollowing(current, at);
      current = followed.target;
      return followed.tail;
    };

    const terminal = deps.openAttach(live.id, target.cwd);
    let exited = false;
    void terminal.exited.then(() => { exited = true; });
    let after: any[] | undefined;
    try {
      const readyBy = deps.now() + deps.attachReadyTimeoutMs;
      for (;;) {
        if (exited) throw new ResidentMessageRefusal("not-running", "The attach client exited before the message was typed");
        const last = terminal.lastOutputAt();
        if (last !== undefined && deps.now() - last >= ATTACH_QUIET_MS) break;
        if (deps.now() > readyBy) throw new ResidentMessageRefusal("delivery-unconfirmed", "The attach terminal never settled; nothing was typed");
        await deps.sleep(deps.pollMs);
      }
      terminal.write(`\x1b[200~${message}\x1b[201~`);
      await deps.sleep(ATTACH_QUIET_MS);
      terminal.write("\r");

      const deliveredBy = deps.now() + deps.deliveryTimeoutMs;
      const seen: any[] = [];
      while (after === undefined) {
        const tail = await read(offset);
        offset = tail.offset;
        seen.push(...records(tail.text));
        const index = seen.findIndex(record => record?.sessionId === target.sessionId && deliveredText(record) === message);
        if (index >= 0) after = seen.slice(index + 1);
        else if (deps.now() > deliveredBy) {
          throw new ResidentMessageRefusal("delivery-unconfirmed",
            "The message was typed into the attach terminal but never appeared in the resident's transcript; attach to inspect its composer");
        } else await deps.sleep(deps.pollMs);
      }
    } finally {
      await terminal.close();
    }

    const replyBy = deps.now() + (options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS);
    for (;;) {
      const turnEnd = after.findIndex(record => record?.type === "system" && record.subtype === "turn_duration" && !record.isSidechain);
      const turn = turnEnd < 0 ? after : after.slice(0, turnEnd);
      const reply = turn.flatMap(record => record?.type === "assistant" && !record.isSidechain && Array.isArray(record.message?.content)
        ? record.message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text as string)
        : []).join("\n");
      if (turnEnd >= 0) return { status: "replied", reply };
      if (deps.now() > replyBy) return { status: "reply-pending", reply };
      await deps.sleep(deps.pollMs);
      const tail = await read(offset);
      offset = tail.offset;
      after.push(...records(tail.text));
    }
  }

  /**
   * Reads the transcript where the session keeps it now. A missing transcript
   * is re-checked against the listing: if the exact same session is listed
   * under another cwd, it moved, and its transcript moved with it (Claude Code
   * carries the file, history intact, to the new directory's project folder),
   * so reading continues there from the same offset. Anything else — the
   * session gone, or no move — is the original failure, never a guess at
   * another session.
   */
  private async readFollowing(target: ResidentAgentTarget, offset: number): Promise<{ target: ResidentAgentTarget; tail: ClaudeTranscriptTail }> {
    try {
      return { target, tail: await this.deps.readTail(target, offset) };
    } catch (error) {
      if (!(error instanceof NativeTranscriptUnavailableError)) throw error;
      const moved = (await this.deps.listBackground())
        .find(entry => entry.sessionId === target.sessionId && entry.cwd !== target.cwd);
      if (!moved) throw error;
      const next = { ...target, cwd: moved.cwd };
      return { target: next, tail: await this.deps.readTail(next, offset) };
    }
  }
}

/** Provider-neutral entry point. Providers without a proven same-session transport refuse. */
export function createResidentAgentMessenger(claude: Partial<ClaudeResidentDeps> = {}): ResidentAgentMessenger {
  const messenger = new ClaudeResidentMessenger(claude);
  return {
    message: (target, text, options) => target.provider === "claude"
      ? messenger.message(target, text, options)
      : Promise.reject(new ResidentMessageRefusal("unsupported-provider",
        `No proven transport delivers to a running ${target.provider} resident's same session`)),
  };
}
