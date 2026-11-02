import { buildProviderLaunchArgs, type ManagedAgentProvider, type ProviderLaunchInputs } from "./agent-runtime.js";
import {
  classifyBlockingText, daemonBlockingCondition, probeClaudeDaemon, runPlainClaude, stripTerminalEscapes,
  type BlockingCondition, type ClaudeDaemonState,
} from "./blocking-conditions.js";
import { listClaudeBackgroundSessions, type ClaudeBackgroundListing } from "./resident-agent.js";

/**
 * One background session to start, in the caller's vocabulary. Drovr spells
 * the provider's flags, their order, and the approvals a background session
 * cannot ask a human for.
 */
export interface BackgroundLaunchRequest extends ProviderLaunchInputs {
  provider: ManagedAgentProvider;
  /** Absolute directory the session runs in; it must already exist. */
  cwd: string;
  /** The session's first message. Omitted, the session starts idle. */
  prompt?: string;
  model?: string;
}

export type BackgroundLaunchRefusal =
  /** Only Claude has a detached background session to start. */
  | "unsupported-provider"
  /** A host-wide condition stops this launch; `blocking` says which and what clears it. */
  | "blocked"
  /** The provider refused or printed nothing Drovr can read as a launch. */
  | "failed"
  /** The provider printed an id no listing ever showed. */
  | "unlisted";

export type BackgroundLaunchResult =
  | {
    ok: true;
    provider: "claude";
    /** What `claude attach|logs|stop|rm|respawn` take. */
    shortId: string;
    /** The full native session id, from the listing, never derived from the short id. */
    sessionId: string;
    cwd: string;
    /** The listing's own state at confirmation, carried through opaque. */
    state?: string;
  }
  | {
    ok: false;
    reason: BackgroundLaunchRefusal;
    detail: string;
    blocking?: BlockingCondition;
    /** Present when a session did start, so the caller can stop or remove it. */
    shortId?: string;
    sessionId?: string;
  };

export interface BackgroundLaunchDeps {
  /**
   * Runs the launch command in `cwd`. A host that wraps launches (a systemd
   * scope, a different user) wraps them here; Drovr only reads what it prints.
   */
  run(argv: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  listBackground(): Promise<ClaudeBackgroundListing[]>;
  /** `claude logs <shortId>`: the session's own screen, read for a blocking prompt. */
  readSessionScreen(shortId: string): Promise<string>;
  probeDaemon(): Promise<ClaudeDaemonState>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** How long a printed id may take to appear in the listing. */
  listTimeoutMs: number;
  /** How long after listing a session is watched for a blocking prompt. */
  settleMs: number;
  pollMs: number;
}

const realDeps: BackgroundLaunchDeps = {
  run: ([command, ...args], cwd) => {
    if (command !== "claude") throw new Error("The default launch runner only runs claude");
    return runPlainClaude(args, cwd);
  },
  listBackground: listClaudeBackgroundSessions,
  readSessionScreen: async (shortId) => (await runPlainClaude(["logs", shortId])).stdout,
  probeDaemon: () => probeClaudeDaemon(),
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
  listTimeoutMs: 10_000,
  settleMs: 4_000,
  pollMs: 250,
};

/** What a short id is made of: never escape bytes or punctuation. */
const SHORT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The argv for one Claude background launch. Every option goes BEFORE `--bg`:
 * measured on claude 2.1.275, `--bg` does not parse what follows it but takes
 * it as the session's prompt, so a flag placed after it is silently demoted to
 * prompt text (Bakr's sessions named "server:yappr", with no subscription).
 */
export function buildBackgroundLaunchArgv(request: BackgroundLaunchRequest): string[] {
  if (request.provider !== "claude") throw new Error(`${request.provider} has no background session launch`);
  const approved = [...new Set([...(request.mcpServersApproved ?? []), ...(request.mcpNotificationServers ?? [])])];
  return [
    "claude",
    ...(request.model ? ["--model", request.model] : []),
    ...buildProviderLaunchArgs("claude", { ...request, mcpServersApproved: approved }),
    "--bg",
    // `--` keeps a prompt that starts with a dash from being read as an option.
    ...(request.prompt === undefined ? [] : ["--", request.prompt]),
  ];
}

/**
 * The short id `claude --bg` printed, measured on claude 2.1.276 as
 * `backgrounded · <id>` on stdout. Colour is stripped first: under FORCE_COLOR,
 * which Claude Code sets in every session, the id arrives as
 * `\x1b[36m582c43dc\x1b[39m` and an unstripped read records escapes as the id.
 */
export function parseBackgroundLaunchId(stdout: string): string | undefined {
  const id = stripTerminalEscapes(stdout).match(/^backgrounded · (\S+)/m)?.[1];
  return id !== undefined && SHORT_ID.test(id) ? id : undefined;
}

/**
 * Start one background session and return its identity, proven against the
 * provider's own listing. A host deletes its own launch parsing and calls this.
 * It never retries, never stops the shared daemon, and never guesses an id
 * from a directory: a result is either a listed session or a stated refusal.
 */
export async function launchBackgroundSession(
  request: BackgroundLaunchRequest,
  overrides: Partial<BackgroundLaunchDeps> = {},
): Promise<BackgroundLaunchResult> {
  if (request.provider !== "claude") {
    return { ok: false, reason: "unsupported-provider", detail: `${request.provider} has no background session launch` };
  }
  const deps = { ...realDeps, ...overrides };

  // A daemon running a deleted executable crashes every session it spawns;
  // refusing up front is cheaper than a launch that reports success and dies.
  const daemonBlock = daemonBlockingCondition(await deps.probeDaemon().catch((): ClaudeDaemonState => ({ running: false })));
  if (daemonBlock) return { ok: false, reason: "blocked", detail: daemonBlock.detail, blocking: daemonBlock };

  const printed = await deps.run(buildBackgroundLaunchArgv(request), request.cwd);
  const output = `${printed.stdout}\n${printed.stderr}`;
  const shortId = printed.exitCode === 0 ? parseBackgroundLaunchId(printed.stdout) : undefined;
  if (shortId === undefined) {
    const blocking = classifyBlockingText("claude", output);
    const text = stripTerminalEscapes(output).trim() || "(no output)";
    return blocking
      ? { ok: false, reason: "blocked", detail: blocking.detail, blocking }
      : { ok: false, reason: "failed", detail: `claude --bg exited ${printed.exitCode} without a session id: ${text}` };
  }

  const deadline = deps.now() + deps.listTimeoutMs;
  let listed: ClaudeBackgroundListing | undefined;
  while (!(listed = (await deps.listBackground()).find((session) => session.id === shortId))) {
    if (deps.now() >= deadline) {
      return { ok: false, reason: "unlisted", detail: `claude --bg printed ${shortId}, which no listing showed within ${deps.listTimeoutMs}ms`, shortId };
    }
    await deps.sleep(deps.pollMs);
  }

  // A started session can still be stopped cold by something only its own
  // screen shows. Watch it briefly; a session that never blocks is the norm.
  const settleBy = deps.now() + deps.settleMs;
  for (;;) {
    const blocking = classifyBlockingText("claude", await deps.readSessionScreen(shortId).catch(() => ""));
    if (blocking) {
      return { ok: false, reason: "blocked", detail: blocking.detail, blocking, shortId, sessionId: listed.sessionId };
    }
    if (deps.now() >= settleBy) break;
    await deps.sleep(deps.pollMs);
  }

  return {
    ok: true,
    provider: "claude",
    shortId,
    sessionId: listed.sessionId,
    cwd: listed.cwd,
    ...(listed.status === undefined ? {} : { state: listed.status }),
  };
}
