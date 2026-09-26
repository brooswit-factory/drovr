import { stripTerminalEscapes } from "./blocking-conditions.js";
import type { DrovrClient } from "./drovr-client.js";
import { readPaneWithDeadline, type PaneReadDeadlineOptions, type UnreadablePane } from "./pane-scan.js";
import { classifyPermissionPrompt } from "./permission-approval.js";
import { classifyStartupPrompt } from "./resident-host.js";

export type { UnreadablePane } from "./pane-scan.js";

/**
 * Every dialog a Claude pane is waiting on, so nothing hangs unseen.
 *
 * On 2026-09-18 two agents sat on a menu no one had met before ("Teach auto
 * mode about your environment?") until Brooswit noticed and answered by hand,
 * while herdr reported both panes idle or done. A host polls this, answers
 * what Drovr knows how to answer, and alerts a person on `unknown`.
 */

type ScanClient = { agent: Pick<DrovrClient["agent"], "list" | "read"> };

/**
 * - `startup`: a prompt `hostResident` answers (trust, development channels,
 *   auto-mode setup), or reports by name (MCP approval).
 * - `permission`: a tool-permission prompt `approvePermission` answers for an operator.
 * - `unknown`: a waiting dialog Drovr recognises by its footer alone; a person must look.
 */
export type BlockingPromptKind = "startup" | "permission" | "unknown";

export interface BlockingPrompt {
  paneId: string;
  label: string | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
  /** herdr's own status, reported alongside because herdr often calls these panes idle. */
  herdrStatus: string;
  kind: BlockingPromptKind;
  /** For `startup` and `permission`: which prompt, e.g. "trust" or the tool name. */
  name: string | undefined;
  /** The last lines of the screen, escapes stripped. */
  excerpt: string;
  /**
   * Present only for a `startup` prompt Drovr can safely answer on its own
   * (trust, development-channels, auto-mode-onboarding, fullscreen-renderer)
   * — the keys `hostResident` would send. Absent for `mcp-approval`, which is
   * a `startup` prompt reported but never answered (approval travels on the
   * launch instead), and for every `permission`/`unknown` prompt.
   */
  keys?: string[];
  /**
   * Present only for `kind: "unknown"`, and only when the dialog's shape
   * could be read with confidence (see `describeUnknownDialog`) — the
   * question and options verbatim, for a host-neutral escalation payload.
   * Absent, never a guess, when the shape is ambiguous.
   */
  dialog?: { question: string; options: string[] };
}

/**
 * The footers Claude draws under a dialog that waits for an answer. A menu is
 * only counted when its footer is on screen, so a transcript that merely
 * quotes a prompt's text is never reported.
 */
const WAITING_FOOTER = /(Enter to confirm|Enter to continue|Enter to select|Esc to cancel)/;

const excerptOf = (screen: string): string => screen.trim().split("\n").slice(-16).join("\n");

/** How many lines directly above a dialog's option block can be its question; further up is prior pane output by definition. */
const QUESTION_TAIL = 6;
/** Anchored at line start: a real footer IS the line, never a clause inside narration quoting one (see `describeUnknownDialog`). */
const FOOTER_LINE = /^\s*(Enter to (confirm|continue|select)|Esc to cancel)/;
const SEPARATOR_OR_TIP = /^(─+|·|Tip:)/;

/**
 * The question and verbatim options of a screen that is genuinely waiting —
 * for an escalation payload nobody may paraphrase. Ported from butchr's
 * `parsePrompt` (`src/agents/prompt.ts`), which closed a self-sustaining
 * loop (KAN-756): a pane merely narrating or quoting a past dialog —
 * including one already escalated, quoted back from a ticket comment —
 * must never itself read as a live menu, or an escalation loop feeds
 * itself forever. Two structural gates, never the mere presence of a
 * footer phrase, do that: the footer must be the very next thing after the
 * last option (blank lines only in between), and the unnumbered shape's
 * option block must carry exactly one visible cursor. `classifyBlockingScreen`
 * already requires `WAITING_FOOTER` before calling this; that check alone
 * is existence, not position, which is why this function re-derives the
 * footer's exact line and does not trust the caller's gate for placement.
 * Undefined when the shape can't be read with confidence — the caller must
 * never guess a payload for a dialog it can't verify.
 */
export function describeUnknownDialog(raw: string): { question: string; options: string[] } | undefined {
  const lines = stripTerminalEscapes(raw).split(/\r?\n/).map((line) => line.replace(/\s+$/, ""));
  return parseNumberedDialog(lines) ?? parseMarkedDialog(lines);
}

function questionAbove(lines: string[], lastAboveOptions: number): string {
  const text: string[] = [];
  for (let i = lastAboveOptions; i >= 0 && text.length < QUESTION_TAIL; i--) {
    const line = lines[i]!.trim();
    if (line === "") { if (text.length) break; continue; }
    if (SEPARATOR_OR_TIP.test(line)) continue;
    text.unshift(line);
  }
  return text.join(" ").trim();
}

/** The `❯ N. label` / `  N. label` shape (permission prompts, some startup menus). */
function parseNumberedDialog(lines: string[]): { question: string; options: string[] } | undefined {
  const options: string[] = [];
  let cursorCount = 0;
  let firstOptionLine = -1;
  let lastOptionLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(❯\s*)?(\d+)\.\s+(.+)$/.exec(lines[i]!);
    if (!match) continue;
    const index = Number(match[2]);
    if (match[1]) cursorCount++;
    options[index - 1] = match[3]!.trim();
    if (firstOptionLine < 0) firstOptionLine = i;
    lastOptionLine = i;
  }
  const found = options.filter((option): option is string => option !== undefined);
  if (found.length < 2 || cursorCount !== 1 || !footerImmediatelyFollows(lines, lastOptionLine)) return undefined;
  return { question: questionAbove(lines, firstOptionLine - 1), options: found };
}

function footerImmediatelyFollows(lines: string[], lastOptionLine: number): boolean {
  if (lastOptionLine < 0) return false;
  const footer = lines.findIndex((line, i) => i > lastOptionLine && FOOTER_LINE.test(line));
  return footer >= 0 && lines.slice(lastOptionLine + 1, footer).every((line) => !line.trim());
}

/** The unnumbered `❯ label` shape (Claude's trust/development-channels menus). */
function parseMarkedDialog(lines: string[]): { question: string; options: string[] } | undefined {
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (FOOTER_LINE.test(lines[i]!)) { footer = i; break; }
  if (footer < 1) return undefined;
  const options: string[] = [];
  let cursorCount = 0;
  let i = footer - 1;
  for (; i >= 0 && options.length < 8; i--) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) { if (options.length) break; continue; }
    const marked = /^\s*(❯|>)\s+(.+)$/.exec(line);
    if (marked) { options.unshift(marked[2]!.trim()); cursorCount++; continue; }
    if (/^\s{2,}\S/.test(line) && trimmed.length <= 80 && !/[.:]$/.test(trimmed)) { options.unshift(trimmed); continue; }
    break;
  }
  if (options.length < 2 || cursorCount !== 1) return undefined;
  return { question: questionAbove(lines, i), options };
}

/** What one screen is waiting on, or undefined when it waits on nothing. */
export function classifyBlockingScreen(raw: string): Pick<BlockingPrompt, "kind" | "name" | "excerpt" | "keys" | "dialog"> | undefined {
  const screen = stripTerminalEscapes(raw);
  if (!WAITING_FOOTER.test(screen)) return undefined;
  const permission = classifyPermissionPrompt(screen);
  if (permission) return { kind: "permission", name: permission.tool, excerpt: excerptOf(screen) };
  const startup = classifyStartupPrompt(screen);
  if (startup && startup.kind !== "unknown-blocking") {
    return {
      kind: "startup", name: startup.kind, excerpt: excerptOf(screen),
      ...("keys" in startup ? { keys: startup.keys } : {}),
    };
  }
  const dialog = describeUnknownDialog(screen);
  return { kind: "unknown", name: undefined, excerpt: excerptOf(screen), ...(dialog ? { dialog } : {}) };
}

export interface ScanBlockingPromptsOptions extends PaneReadDeadlineOptions {}

export interface ScanBlockingPromptsResult {
  prompts: BlockingPrompt[];
  unreadable: UnreadablePane[];
}

/**
 * Every Claude pane waiting on a dialog. Every Claude pane's screen is read,
 * whatever herdr says its status is, bounded by `readTimeoutMs` (default
 * 1500) per pane so one hung `agent.read` can't hold up the whole scan —
 * reads run in parallel, so the scan takes roughly the slowest read, capped
 * by the deadline. A pane whose screen cannot be read — it rejects, or it
 * never resolves within the deadline — is reported in `unreadable`, never
 * silently treated as "not blocked".
 */
export async function scanBlockingPrompts(client: ScanClient, options: ScanBlockingPromptsOptions = {}): Promise<ScanBlockingPromptsResult> {
  const { agents } = await client.agent.list();
  const found = await Promise.all(agents.filter((agent) => agent.agent === "claude").map(async (agent) => {
    const base = {
      paneId: agent.pane_id,
      label: agent.name ?? undefined,
      sessionId: agent.agent_session?.kind === "id" ? agent.agent_session.value : undefined,
      cwd: agent.cwd ?? undefined,
      herdrStatus: agent.agent_status,
    };
    const read = await readPaneWithDeadline(client, agent.pane_id, options);
    if (read.kind !== "ok") return { unreadable: { ...base, reason: read.kind, detail: read.detail } };
    const blocking = classifyBlockingScreen(read.screen);
    return blocking === undefined ? {} : { prompt: { ...base, ...blocking } };
  }));
  return {
    prompts: found.flatMap((r) => (r.prompt ? [r.prompt] : [])),
    unreadable: found.flatMap((r) => (r.unreadable ? [r.unreadable] : [])),
  };
}

/**
 * Every Claude pane waiting on a dialog. A thin wrapper over
 * `scanBlockingPrompts` that drops its `unreadable` list — a pane whose
 * screen could not be read is silently absent from the result, exactly as
 * before. Callers that need to tell "not blocked" apart from "could not
 * check" should call `scanBlockingPrompts` directly.
 */
export async function listBlockingPrompts(client: ScanClient): Promise<BlockingPrompt[]> {
  return (await scanBlockingPrompts(client)).prompts;
}
