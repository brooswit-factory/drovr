import type { SessionLimitOutcome } from "./session-limit.js";

/**
 * Codex usage-limit recognition, from ANSI-stripped pane text and from the
 * error message of a failed Codex turn.
 *
 * Every anchor is wording measured, not guessed:
 *
 * - `Automatically switched to <model> due to usage limits.` and its
 *   recovery twin `Automatically switched back to <model> because ordinary
 *   usage is available again.` are string constants in the Codex CLI
 *   binary (0.155.0-alpha.16.4). The first was observed live on quota-blocked
 *   idle Codex panes on 2026-09-24, as a `• ` history cell at column 0,
 *   followed either by the server's own "Add credits … or wait for usage to
 *   reset after 16:03 on 29 Sep." dialog or directly by the composer.
 * - `You’ve hit your usage limit.` (U+2019) opens every usage-limit error
 *   variant in the same binary, and was observed as the message of a failed
 *   Codex App Server turn. A TUI error cell renders it behind `■ `.
 * - The reset clock `16:03 on 29 Sep` matches the binary's own
 *   `%H:%M on %-d %b` (optionally ` %Y`) format.
 *
 * Nothing else establishes a Codex quota: not HTTP status text, not a
 * `rate limit` phrase, not the model's own prose.
 */

/** A Codex history cell starts at column 0 with a bullet; its continuation is indented. */
const SWITCHED = /^• Automatically switched to (.+?) due to usage limits\.$/;
const SWITCHED_BACK = /^• Automatically switched back to (.+?) because ordinary usage is available again\.$/;
const ERROR_CELL = /^■ (You(?:'|’)ve hit your usage limit\b.*)$/;
const USAGE_LIMIT_MESSAGE = /^You(?:'|’)ve hit your usage limit\b/;

/**
 * What may follow a live notice: blank lines, indented continuation (the
 * notice's own wrapped dialog, the composer's footer), and `›` lines (the
 * dialog's selection cursor, and the composer itself). Any other column-0
 * line is a later history cell — the agent kept working (on the fallback
 * model, or after the reset) — so the notice is history, not current state.
 */
function laterCell(lines: readonly string[], from: number): string | null {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s/.test(line) || line.startsWith("›")) continue;
    return line;
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function localDate(year: number, month: number, day: number, hour: number, minute: number): number | null {
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const date = new Date(year, month, day, hour, minute, 0, 0);
  return date.getMonth() === month && date.getDate() === day ? date.getTime() : null;
}

/**
 * A dated reset without a printed year is the occurrence nearest `now`:
 * this year, unless that is more than half a year behind (a late-December
 * notice read in January is still this year; a January reset read in
 * December is next year). A reset already passed stays in the past, so the
 * registry treats the account as available again rather than inventing a
 * later one.
 */
function resolveDated(now: Date, month: number, day: number, hour: number, minute: number, year?: number): number | null {
  if (year !== undefined) return localDate(year, month, day, hour, minute);
  const candidate = localDate(now.getFullYear(), month, day, hour, minute);
  if (candidate === null) return null;
  if (now.getTime() - candidate > 183 * 86_400_000) return localDate(now.getFullYear() + 1, month, day, hour, minute);
  return candidate;
}

/**
 * Parses the reset Codex printed, as epoch ms in host local time, or null.
 * Accepts the dialog's `reset after 16:03 on 29 Sep[ 2026]` and the error's
 * `try again at 4:03 PM`, `try again at Sep 29 at 4:03 PM` and
 * `try again at Sep 29th, 2026 4:03 PM`. Never invents a reset.
 */
export function parseCodexUsageReset(text: string, now: Date): number | null {
  const flat = text.replace(/\s+/g, " ");
  const dated = /\breset after (\d{1,2}):(\d{2}) on (\d{1,2}) ([A-Za-z]{3})(?: (\d{4}))?\b/.exec(flat);
  if (dated) {
    return resolveDated(now, MONTHS.indexOf(dated[4]!.toLowerCase()), Number(dated[3]), Number(dated[1]), Number(dated[2]),
      dated[5] === undefined ? undefined : Number(dated[5]));
  }
  const retry = /\btry again at (?:([A-Za-z]{3}) (\d{1,2})(?:st|nd|rd|th)?(?:, (\d{4}))?(?: at)? )?(\d{1,2}):(\d{2}) ?([AaPp][Mm])\b/.exec(flat);
  if (!retry) return null;
  let hour = Number(retry[4]);
  const minute = Number(retry[5]);
  if (hour < 1 || hour > 12) return null;
  hour = hour % 12 + (retry[6]!.toLowerCase() === "pm" ? 12 : 0);
  if (retry[1] !== undefined) {
    return resolveDated(now, MONTHS.indexOf(retry[1].toLowerCase()), Number(retry[2]), hour, minute,
      retry[3] === undefined ? undefined : Number(retry[3]));
  }
  const candidate = localDate(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  if (candidate === null) return null;
  return candidate < now.getTime() ? candidate + 86_400_000 : candidate;
}

/**
 * Classify ANSI-stripped Codex pane text. Only the MOST RECENT usage notice
 * (switch, switch back, or usage-limit error cell) is considered, and only
 * at column 0: tool output and quoted text render indented under their own
 * cell. A switch back to ordinary usage is not a refusal. A notice followed
 * by a later history cell is `suppressed` with the reason, because the
 * agent has carried on since.
 *
 * Known residual risk, the same shape as the Claude classifier's: an agent
 * message whose first line is byte-for-byte the notice renders identically.
 * Callers must still apply the idle/done gate.
 */
export function classifyCodexUsageLimitText(text: string, now: Date): SessionLimitOutcome {
  const lines = text.split("\n").map(line => line.replace(/\s+$/, ""));
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (SWITCHED_BACK.test(line)) return { kind: "not-recognised" };
    const switched = SWITCHED.exec(line);
    const error = switched ? null : ERROR_CELL.exec(line);
    if (!switched && !error) continue;
    const raw = error ? error[1]! : line.slice(2);
    const later = laterCell(lines, i + 1);
    if (later !== null) {
      return {
        kind: "suppressed", raw,
        reason: `a Codex usage-limit notice is followed by a later history cell ("${later.slice(0, 60)}") — ` +
          `the agent carried on after it, so it is history, not current pane state`,
      };
    }
    // The notice's own block: the line itself plus its indented continuation.
    let end = i + 1;
    while (end < lines.length && (!lines[end]!.trim() || /^\s/.test(lines[end]!))) end++;
    return { kind: "recognised", resetsAt: parseCodexUsageReset(lines.slice(i, end).join("\n"), now), raw };
  }
  return { kind: "not-recognised" };
}

/**
 * Classify the error of a failed Codex turn, from `codex exec --json`
 * (`turn.failed.error.message` / `error.message`) or the App Server
 * (`turn.error`, whose `codexErrorInfo` is `"usageLimitExceeded"` for this
 * case). The message must BEGIN with Codex's own usage-limit sentence; a
 * message that merely mentions it is not a refusal. The structured
 * App Server code alone is also sufficient.
 */
export function codexTurnErrorQuota(error: unknown, now: Date): { resetsAt: number | null; raw: string } | null {
  let message: string | undefined;
  let info: unknown;
  if (typeof error === "string") message = error;
  else if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.message === "string") message = value.message;
    info = value.codexErrorInfo ?? value.codex_error_info;
  }
  const structured = info === "usageLimitExceeded"
    || (!!info && typeof info === "object" && "usageLimitExceeded" in (info as Record<string, unknown>));
  const trimmed = message?.trim() ?? "";
  if (!structured && !USAGE_LIMIT_MESSAGE.test(trimmed)) return null;
  const raw = trimmed || "usageLimitExceeded";
  return { resetsAt: parseCodexUsageReset(raw, now), raw };
}
