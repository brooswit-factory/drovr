import { stripTerminalEscapes } from "./blocking-conditions.js";
import type { DrovrClient } from "./drovr-client.js";
import { readPaneWithDeadline, type PaneReadDeadlineOptions, type UnreadablePane } from "./pane-scan.js";
import { classifyPermissionPrompt, type PermissionPrompt } from "./permission-approval.js";
import { classifyRateLimitOptions, type RateLimitOptionsPrompt } from "./rate-limit-options.js";
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
 * - `rate-limit-options`: Claude Code's `/rate-limit-options` weekly-limit menu
 *   (FACTORY-345/FACTORY-347) — `answerRateLimitOptions` (rate-limit-options.ts)
 *   answers it, never selecting "Stop and wait" or "Switch to usage credits".
 * - `unknown`: a waiting dialog Drovr recognises by its footer alone; a person must look.
 */
export type BlockingPromptKind = "startup" | "permission" | "rate-limit-options" | "unknown";

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
  /**
   * Present only for `kind: "permission"` — the full parsed prompt
   * (`tool`, `request`, `question`, `options`, `cursor`, `promptId`), so a
   * caller can decide for itself whether ITS OWN answering pass (running at
   * a `PermissionScope` only the caller knows) will actually answer this
   * dialog, without re-reading the screen or re-implementing
   * `classifyPermissionPrompt`. See `blocking-escalation.ts`'s escalation
   * gap for why this exists: a `permission` dialog is not always safe to
   * assume answered.
   */
  permission?: PermissionPrompt;
  /**
   * Present only for `kind: "rate-limit-options"` — the full parsed prompt
   * (`options`, `cursor`, `waitHereIndex`, `stopIndex`, `switchIndex`,
   * `promptId`), for the same reason `permission` is exposed: a caller can
   * decide whether its own answering pass will actually answer this dialog
   * without re-reading the screen or re-implementing `classifyRateLimitOptions`.
   */
  rateLimitOptions?: RateLimitOptionsPrompt;
}

/**
 * The footers Claude draws under a dialog that waits for an answer. A menu is
 * only counted when its footer is on screen, so a transcript that merely
 * quotes a prompt's text is never reported. Includes WebFetch's stand-in for
 * a footer (FACTORY-365/6): it draws no `Esc to cancel` line at all, only an
 * inline `(esc)` hint on its "No, …" option.
 */
const WAITING_FOOTER = /(Enter to confirm|Enter to continue|Enter to select|Esc to cancel|No\b[^\n]*\(esc\))/;

const excerptOf = (screen: string): string => screen.trim().split("\n").slice(-16).join("\n");

/** How many candidate (non-chatter) lines directly above a dialog's option block can be its question; further up is prior pane output by definition. */
const QUESTION_TAIL = 6;
/** Anchored at line start: a real footer IS the line, never a clause inside narration quoting one (see `describeUnknownDialog`). */
const FOOTER_LINE = /^\s*(Enter to (confirm|continue|select)|Esc to cancel)/;
const SEPARATOR_OR_TIP = /^(─+|·|Tip:)/;
/**
 * A bracket-tagged notification line (e.g. a `[butchr] …` nudge landing on a
 * still-live pane) — chatter injected between a dialog's real question and
 * its option block, never a question of the dialog's own (FACTORY-377).
 * Skipped like `SEPARATOR_OR_TIP` rather than accepted: unlike a separator,
 * which never disguises itself as content, this is exactly the shape a
 * dropped-in notification takes, so treating it as opaque noise to scan past
 * — rather than as the question — is what lets the real question underneath
 * it still be found.
 */
const NOTIFICATION_CHATTER = /^\[[^\]\n]+\]/;

/**
 * `AskUserQuestion`'s side-by-side layout draws a boxed preview column to
 * the right of the option list — border and fill lines introduced by 2+
 * spaces then a box-drawing char, never real option text. Measured live
 * (2026-09-26): stripping everything from that point on, on every line,
 * removes the column (and the `✂ N lines hidden` truncation marker, which
 * lives entirely inside it) before the option regex ever sees the line, so
 * none of it can bleed into a label.
 */
const PREVIEW_COLUMN = /\s{2,}[┌┐└┘├┤─│]/;
function stripPreviewColumn(line: string): string {
  const at = line.search(PREVIEW_COLUMN);
  return at < 0 ? line : line.slice(0, at).replace(/\s+$/, "");
}

/** A full-width rule, distinct from `SEPARATOR_OR_TIP`: on an AskUserQuestion screen it marks the boundary before the "Chat about this" meta-action, never a real option. */
const FULL_WIDTH_SEPARATOR = /^─{10,}$/;

/**
 * Trailing lines a real footer can sit behind without the gap meaning
 * "this isn't actually a live dialog": the divider before AskUserQuestion's
 * "Chat about this" meta-action, that action itself (numbered, in the
 * plain layout, or not, in the side-by-side one — measured live, both
 * occur), and the note prompt the preview column adds. An unrecognised
 * non-blank line still fails the gate below.
 */
const TRAILER_LINE = /^\s*(?:─{10,}|Notes: press n to add notes|(?:\d+\.\s+)?Chat about this)\s*$/;

/**
 * An indented line with no number of its own, directly after an option
 * line. Only a genuine wrapped label when the screen carries a preview
 * column: measured live, a preview column narrows the option list enough
 * to wrap a long label onto a second line, and — on the same screen —
 * suppresses each option's own description line, which a plain (no
 * preview) dialog instead prints on this exact same kind of line. Folding
 * this unconditionally would swallow a plain dialog's descriptions into
 * its option labels, so it's gated on `hasPreviewColumn` below rather than
 * applied whenever the shape matches.
 */
const WRAPPED_LABEL_CONTINUATION = /^\s+\S/;

const NUMBERED_OPTION = /^\s*(❯\s*)?(\d+)\.\s+(.+)$/;

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
 *
 * STATEMENT OF INTENT (FACTORY-377): `question` is meant to be the dialog's
 * own question and nothing else — never a window onto whatever else happens
 * to sit on screen. `options` is read structurally (the numbered/marked
 * lines themselves), so it can't pick up stray pane content; `question` used
 * to be read positionally instead (whatever non-blank text filled
 * `QUESTION_TAIL` lines above the options), which let an unrelated line —
 * command output, file contents, a notification nudge — leave the pane
 * through this field and reach a host's public escalation comment verbatim.
 * `questionAbove` now requires the collected text to itself look like a
 * question (ending in `?`) and skips known chatter shapes while climbing, so
 * a screen with nothing question-shaped above its options returns undefined
 * for the whole dialog rather than confidently quoting whatever was there.
 * This is a promise of confinement to the dialog, not merely of verbatim
 * fidelity to whatever this function happened to extract — the two are
 * different guarantees, and only the fix above makes the first one true.
 */
export function describeUnknownDialog(raw: string): { question: string; options: string[] } | undefined {
  const lines = stripTerminalEscapes(raw).split(/\r?\n/).map((line) => line.replace(/\s+$/, ""));
  return parseNumberedDialog(lines) ?? parseMarkedDialog(lines);
}

/**
 * The dialog's own question, scanning up from directly above the option
 * block — or undefined when nothing in that climb reads as one.
 *
 * `SEPARATOR_OR_TIP` and `NOTIFICATION_CHATTER` lines are both skipped
 * outright rather than counted or accepted: they cost nothing against
 * `QUESTION_TAIL`, so a real question sitting just above injected chatter
 * (FACTORY-377's measured case — a `[butchr] …` nudge landing directly above
 * the option block) is still found instead of being shadowed by the chatter
 * or by running out of window on it. What IS collected must still look like
 * a question — end in `?` — once joined; a screen where nothing above the
 * options does is reported as undefined here, not papered over with
 * whatever non-blank text happened to be sitting there. Undefined here fails
 * the whole dialog (see `describeUnknownDialog`): a caller must never get a
 * confidently wrong payload in place of an honest "couldn't read this one".
 */
function questionAbove(lines: string[], lastAboveOptions: number): string | undefined {
  const text: string[] = [];
  for (let i = lastAboveOptions; i >= 0 && text.length < QUESTION_TAIL; i--) {
    const line = lines[i]!.trim();
    if (line === "") { if (text.length) break; continue; }
    if (SEPARATOR_OR_TIP.test(line) || NOTIFICATION_CHATTER.test(line)) continue;
    text.unshift(line);
  }
  const question = text.join(" ").trim();
  return question !== "" && question.endsWith("?") ? question : undefined;
}

/**
 * The `❯ N. label` / `  N. label` shape (permission prompts, some startup
 * menus, and AskUserQuestion — plain, or side-by-side with a preview
 * column stripped by `stripPreviewColumn` first).
 */
function parseNumberedDialog(rawLines: string[]): { question: string; options: string[] } | undefined {
  const hasPreviewColumn = rawLines.some((line) => PREVIEW_COLUMN.test(line));
  const lines = rawLines.map(stripPreviewColumn);
  const first = lines.findIndex((line) => NUMBERED_OPTION.test(line));
  if (first < 0) return undefined;
  // AskUserQuestion's "Chat about this" meta-action sits past a full-width
  // separator, sometimes numbered like a real option — bound the scan to
  // before it so it's never read as one (see `TRAILER_LINE` for how the
  // footer gate still tolerates it, and the separator itself, below).
  let separator = -1;
  for (let i = first; i < lines.length; i++) if (FULL_WIDTH_SEPARATOR.test(lines[i]!)) { separator = i; break; }
  const end = separator >= 0 ? separator : lines.length;

  const options: string[] = [];
  let cursorCount = 0;
  let lastOptionLine = -1;
  let lastOptionIndex = -1;
  for (let i = first; i < end; i++) {
    const line = lines[i]!;
    const match = NUMBERED_OPTION.exec(line);
    if (match) {
      const index = Number(match[2]);
      if (match[1]) cursorCount++;
      options[index - 1] = match[3]!.trim();
      lastOptionLine = i;
      lastOptionIndex = index - 1;
      continue;
    }
    if (hasPreviewColumn && lastOptionIndex >= 0 && i === lastOptionLine + 1 && WRAPPED_LABEL_CONTINUATION.test(line)) {
      options[lastOptionIndex] = `${options[lastOptionIndex]} ${line.trim()}`;
      lastOptionLine = i;
    }
  }
  const found = options.filter((option): option is string => option !== undefined);
  if (found.length < 2 || cursorCount !== 1 || !footerImmediatelyFollows(lines, lastOptionLine)) return undefined;
  const question = questionAbove(lines, first - 1);
  return question === undefined ? undefined : { question, options: found };
}

function footerImmediatelyFollows(lines: string[], lastOptionLine: number): boolean {
  if (lastOptionLine < 0) return false;
  const footer = lines.findIndex((line, i) => i > lastOptionLine && FOOTER_LINE.test(line));
  return footer >= 0 && lines.slice(lastOptionLine + 1, footer).every((line) => !line.trim() || TRAILER_LINE.test(line));
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
  const question = questionAbove(lines, i);
  return question === undefined ? undefined : { question, options };
}

/** What one screen is waiting on, or undefined when it waits on nothing. */
export function classifyBlockingScreen(raw: string): Pick<BlockingPrompt, "kind" | "name" | "excerpt" | "keys" | "dialog" | "permission" | "rateLimitOptions"> | undefined {
  const screen = stripTerminalEscapes(raw);
  if (!WAITING_FOOTER.test(screen)) return undefined;
  const permission = classifyPermissionPrompt(screen);
  if (permission) return { kind: "permission", name: permission.tool, excerpt: excerptOf(screen), permission };
  const rateLimitOptions = classifyRateLimitOptions(screen);
  if (rateLimitOptions) return { kind: "rate-limit-options", name: undefined, excerpt: excerptOf(screen), rateLimitOptions };
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
