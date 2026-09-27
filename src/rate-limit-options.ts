import { createHash } from "node:crypto";
import { stripTerminalEscapes } from "./blocking-conditions.js";
import type { DrovrClient } from "./drovr-client.js";

/**
 * Claude Code's `/rate-limit-options` menu (FACTORY-345): once a session
 * hits its weekly usage limit, Claude Code opens this dialog and the
 * session sits on it until answered:
 *
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
 *    What do you want to do?
 *
 *    ❯ 1. Stop and wait for limit to reset
 *      2. Wait here, then continue automatically at Oct 1, 8am
 *      3. Switch to usage credits
 *
 *    Enter to confirm · Esc to cancel
 *
 * Measured directly from real captures held on this host
 * (test/fixtures/rate-limit-options/pane-cap-escalation-*.txt — three
 * captures of the same live pane, FACTORY-327's escalation, with butchr's
 * own notification chatter at a different depth in each): the separator
 * rule above the question is U+2594 (▔) UPPER ONE EIGHTH BLOCK, not U+2500
 * (─) — verified byte-for-byte against these fixtures at this commit. This
 * contradicts an earlier claim on this story that ▔ was only Jira/butchr
 * comment-rendering chrome and never real pane content; it demonstrably is,
 * on at least this capture. Re-verify at your own checkout before trusting
 * either claim. This module does not use the separator at all, for exactly
 * the reason this discrepancy illustrates: a rule character is not a stable
 * signal to build recognition on.
 *
 * NOT a permission prompt: `classifyPermissionPrompt` (permission-approval.ts)
 * correctly returns `undefined` for this screen — it fails that function's
 * QUESTION gate ("Do you want to …?"; this asks "What do you want to do?")
 * and would also fail the "Yes"/"No" option-shape gates. That refusal is
 * `permission-approval.ts`'s own safety property and this module MUST NOT
 * weaken it: `optionFor(prompt, "once")` (`options.indexOf("Yes")`) being -1
 * for this shape is currently the only thing stopping an unattended
 * permission-answering pass from pressing this dialog's destructive option 1
 * ("Stop and wait for limit to reset", which ends the session). See
 * test/rate-limit-options.test.ts's regression test pinning
 * `classifyPermissionPrompt(fixture) === undefined`.
 *
 * IDENTITY: recognised by its three option LABELS (matched by wording, not
 * digit position — the reset clock in option 2's label is variable and never
 * matched on), never by the question line's position relative to the option
 * block. Measured on drovr main at c6da5fc (FACTORY-345 comment 26620):
 * `blocking-prompts.ts`'s `describeUnknownDialog` looks for the question
 * within `QUESTION_TAIL` (6) lines above the option block, and chatter
 * landing INSIDE that window is read as the question itself, corrupting the
 * escalation payload and drifting its fingerprint. This module never reads
 * the question, precisely to stay clear of that fragility — it is not this
 * story's to fix (filed separately by the story owner) and this recognizer
 * has no reason to depend on it.
 *
 * KNOWN, BOUNDED RESIDUAL RISK, same class as session-limit.ts's own
 * documented one: a pane whose scrollback happens to contain this exact
 * dialog's cursor marker, all three labels verbatim, and the footer
 * immediately following — e.g. a `cat`/`grep`/`Read` of one of this
 * repo's own fixture files landing at the end of a pane's visible screen —
 * is structurally indistinguishable from a live dialog from flattened pane
 * text alone. This module does not close that; callers must still apply
 * whatever idle/done gate they already use for other interactive-prompt
 * recognisers (the same mitigation session-limit.ts and permission-approval.ts
 * rely on).
 */

const STOP_AND_WAIT = /^Stop and wait for limit to reset\b/;
const WAIT_HERE = /^Wait here, then continue automatically\b/;
const SWITCH_CREDITS = /^Switch to usage credits\b/;
/** The variable reset clock in option 2's own label, e.g. "at Oct 1, 8am" or "at Oct 1, 8:30am". Never matched on for identity — only parsed, best-effort, for the stale-dialog check. */
const WAIT_HERE_RESET = /\bat\s+([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

const OPTION = /^\s*(❯\s*)?\d+\.\s+(.+?)\s*$/;
/** Anchored to the line's start, same discipline as every other blocking-dialog footer check in this repo. */
const FOOTER_LINE = /^\s*Enter to confirm\s*·\s*Esc to cancel\s*$/;

export interface RateLimitOptionsPrompt {
  /** Verbatim, in the order Claude Code drew them — never assumed to be [stop, wait, switch]. */
  options: string[];
  /** Index into `options` of the option under the cursor. */
  cursor: number;
  /** Index into `options` of "Wait here, then continue automatically …" — the only option this module ever presses to advance. */
  waitHereIndex: number;
  /** Index into `options` of "Stop and wait for limit to reset" — recorded only so a caller can assert it is never pressed. */
  stopIndex: number;
  /** Index into `options` of "Switch to usage credits" — recorded only so a caller can assert it is never pressed. */
  switchIndex: number;
  /** A hash of the options array, in displayed order: names this exact prompt, not the cursor position. */
  promptId: string;
}

/**
 * Claude Code's `/rate-limit-options` menu on a screen, or `undefined` for
 * anything else — including a genuine permission prompt, a startup menu, or
 * this same dialog with any option label that doesn't match (a labels
 * mismatch is a real, distinct shape this module refuses to guess about;
 * the caller's existing "unknown" escalation path already handles it, see
 * the module doc above).
 *
 * Scans the WHOLE text for a run of 3 consecutive option lines (an
 * unnumbered/renumbered shape is a different dialog, not this one) covering
 * all three known labels with exactly one cursor among them, immediately
 * followed (blank lines only in between) by the exact footer line. Does not
 * look at, or require, the question line at all — see the module doc's
 * IDENTITY section for why.
 */
export function classifyRateLimitOptions(raw: string): RateLimitOptionsPrompt | undefined {
  const lines = stripTerminalEscapes(raw).split(/\r?\n/);
  for (let i = 0; i + 2 < lines.length; i++) {
    const m0 = OPTION.exec(lines[i]!);
    if (!m0) continue;
    const m1 = OPTION.exec(lines[i + 1]!);
    const m2 = OPTION.exec(lines[i + 2]!);
    if (!m1 || !m2) continue;
    const matches = [m0, m1, m2];
    const cursorCount = matches.filter((m) => !!m[1]).length;
    if (cursorCount !== 1) continue;
    const options = matches.map((m) => m[2]!);
    const stopIndex = options.findIndex((o) => STOP_AND_WAIT.test(o));
    const waitHereIndex = options.findIndex((o) => WAIT_HERE.test(o));
    const switchIndex = options.findIndex((o) => SWITCH_CREDITS.test(o));
    if (stopIndex < 0 || waitHereIndex < 0 || switchIndex < 0) continue;

    let end = i + 3;
    let footerFound = false;
    for (; end < lines.length && end < i + 6; end++) {
      const trimmed = lines[end]!.trim();
      if (!trimmed) continue;
      footerFound = FOOTER_LINE.test(lines[end]!);
      break;
    }
    if (!footerFound) continue;

    const cursor = matches.findIndex((m) => !!m[1]);
    const promptId = createHash("sha256").update(JSON.stringify(options)).digest("hex").slice(0, 16);
    return { options, cursor, waitHereIndex, stopIndex, switchIndex, promptId };
  }
  return undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Best-effort parse of the reset clock printed in option 2's own label
 * ("Wait here, then continue automatically at Oct 1, 8am") to the next
 * occurrence at or after `now`, treated as host-local time — the label
 * carries no timezone or year, so this is necessarily approximate. Returns
 * `null` when the label doesn't parse; callers must treat `null` as "cannot
 * tell", per the stale-dialog handling in `resolveRateLimitOptionsAction`
 * below, never as "not stale".
 */
export function parseWaitHereReset(waitHereLabel: string, now: Date): number | null {
  const m = WAIT_HERE_RESET.exec(waitHereLabel);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  const day = Number(m[2]);
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  const ampm = m[5]!.toLowerCase();
  if (month < 0 || day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) return null;
  hour = hour % 12 + (ampm === "pm" ? 12 : 0);
  const year = now.getFullYear();
  const candidate = new Date(year, month, day, hour, minute, 0, 0);
  if (candidate.getMonth() !== month || candidate.getDate() !== day) return null;
  // A date more than ~half a year in the past is next year's occurrence, not a stale one from last year.
  if (now.getTime() - candidate.getTime() > 183 * 86_400_000) candidate.setFullYear(year + 1);
  return candidate.getTime();
}

/**
 * What `resolveRateLimitOptionsAction` decided to do, and why — so a caller
 * (and this module's own tests) can assert the safety properties directly
 * rather than re-deriving them from keystrokes:
 *
 * - `"wait"`: press the "Wait here, then continue automatically" option.
 *   Chosen whenever the printed reset time is still in the future, OR could
 *   not be determined at all (see `resolveRateLimitOptionsAction`'s doc for
 *   why "cannot tell" resolves here, not to `"escape"`) — this is always
 *   safe because it can NEVER select option 1 or option 3.
 * - `"escape"`: the printed reset time has already passed; release the
 *   session (Escape) rather than trust a display that may be stale, mirroring
 *   the director's manual recovery from FACTORY-345.
 */
export type RateLimitOptionsAction =
  | { kind: "wait"; targetIndex: number }
  | { kind: "escape"; reason: string };

/**
 * Decide how to answer an already-classified prompt. NEVER returns an
 * action that presses `stopIndex` or `switchIndex` — those two indices exist
 * on `RateLimitOptionsPrompt` only so a caller can assert this in its own
 * tests, never so this function (or any other) presses them.
 *
 * Stale-dialog handling (FACTORY-347 AC5): if the printed reset time can be
 * parsed and has already passed `now`, this returns `"escape"` rather than
 * pressing "wait" — pressing "wait" on a dialog whose own printed promise
 * ("continue automatically at <time>") already elapsed risks trusting a
 * stale render instead of re-checking. If the reset time cannot be parsed at
 * all, this resolves to `"wait"`, not `"escape"`: an unparsed date is a
 * "cannot tell" case, and the two candidate actions are not symmetric risks
 * — `"wait"` can never end the session or spend money (it only ever presses
 * `waitHereIndex`), while an unwarranted `"escape"` risks releasing a
 * session that was never actually stale. Explicitly documented per AC5's
 * own instruction to state the choice and why.
 */
export function resolveRateLimitOptionsAction(prompt: RateLimitOptionsPrompt, now: Date): RateLimitOptionsAction {
  const resetAt = parseWaitHereReset(prompt.options[prompt.waitHereIndex]!, now);
  if (resetAt !== null && resetAt <= now.getTime()) {
    return { kind: "escape", reason: `printed reset time (${new Date(resetAt).toISOString()}) has already passed as of ${now.toISOString()}` };
  }
  return { kind: "wait", targetIndex: prompt.waitHereIndex };
}

type AnswerClient = { agent: Pick<DrovrClient["agent"], "read" | "sendKeys"> };

export type AnswerRateLimitOptionsRefusalReason =
  | "no-prompt"
  /** The screen shows a different prompt than the one the caller classified. */
  | "prompt-changed"
  | "keys-failed";

export type AnswerRateLimitOptionsResult =
  | { ok: true; action: RateLimitOptionsAction; prompt: RateLimitOptionsPrompt }
  | { ok: false; reason: AnswerRateLimitOptionsRefusalReason; detail: string };

const readScreen = (client: AnswerClient, paneId: string): Promise<string> =>
  client.agent.read({ target: paneId, source: "visible", strip_ansi: true }).then((read) => read.read.text);

function keysFor(cursor: number, target: number): string[] {
  const step = target > cursor ? "down" : "up";
  return [...Array.from({ length: Math.abs(target - cursor) }, () => step), "enter"];
}

/**
 * Re-reads `paneId`, refuses if it no longer shows the exact prompt
 * `promptId` names (never answers a prompt the caller didn't actually see),
 * decides the action via `resolveRateLimitOptionsAction`, and sends the
 * keys for it — arrow keys to the target option then Enter for `"wait"`,
 * a bare Escape for `"escape"`. Mirrors `approvePermission`'s re-read-then-
 * refuse-on-change discipline (permission-approval.ts) without its audit
 * log, which this module has no acceptance criterion requiring.
 */
export async function answerRateLimitOptions(
  client: AnswerClient,
  paneId: string,
  promptId: string,
  now: Date = new Date(),
): Promise<AnswerRateLimitOptionsResult> {
  const screen = await readScreen(client, paneId).catch(() => "");
  const prompt = classifyRateLimitOptions(screen);
  if (!prompt) return { ok: false, reason: "no-prompt", detail: `pane ${paneId} shows no rate-limit-options prompt` };
  if (prompt.promptId !== promptId) {
    return { ok: false, reason: "prompt-changed", detail: `pane ${paneId} now shows a different prompt (${prompt.promptId}); re-classify and answer that one` };
  }
  const action = resolveRateLimitOptionsAction(prompt, now);
  const keys = action.kind === "wait" ? keysFor(prompt.cursor, action.targetIndex) : ["escape"];
  try {
    await client.agent.sendKeys({ target: paneId, keys });
  } catch (error) {
    return { ok: false, reason: "keys-failed", detail: `whether a key reached pane ${paneId} is unknown: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, action, prompt };
}
