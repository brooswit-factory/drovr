import { createHash, randomUUID } from "node:crypto";
import { stripTerminalEscapes } from "./blocking-conditions.js";
import type { DrovrClient } from "./drovr-client.js";
import { defaultDeps, type PermissionApprovalDeps } from "./permission-approval.js";
import { readPaneWithDeadline, type PaneReadDeadlineOptions, type UnreadablePane } from "./pane-scan.js";

/**
 * Approving a Codex session's pending tool-approval prompt without a
 * terminal — the Codex-vendor twin of `permission-approval.ts`'s Claude
 * dialog, for a Codex session run in its manual (non-bypass) approval mode
 * — i.e. launched WITHOUT `--dangerously-bypass-approvals-and-sandbox` (see
 * `buildAgentStartParams` in `agent-runtime.ts`).
 *
 * Measured on codex-cli 0.145.0 in a herdr pane (2026-09-26); the exact
 * captures are `test/fixtures/codex-approval/*.txt` and the full wording
 * table is `docs/codex-permission-approval.md`. Three distinct on-screen
 * shapes were captured, covering command execution, network access (which
 * renders the SAME shape as command execution — see below), and file
 * edit/patch. An MCP tool call is a fourth, structurally different shape.
 * No other approval kind was observed live; anything else that looks like an
 * approval dialog but does not match one of these three shapes is reported
 * as `"unrecognised"`, never guessed at.
 *
 *   Would you like to run the following command?
 *
 *   Environment: local
 *
 *   Reason: Allow creating drovr-codex-probe-home.txt in your home directory?
 *
 *   $ touch ~/drovr-codex-probe-home.txt
 *
 * › 1. Yes, proceed (y)
 *   2. Yes, and don't ask again for commands that start with `touch '~/drovr-codex-probe-
 *      home.txt'` (p)
 *   3. No, and tell Codex what to do differently (esc)
 *
 *   Press enter to confirm or esc to cancel
 *
 * A network-access escalation (`touch ~/x` above swapped for `curl … https://example.com`)
 * renders the IDENTICAL shape and footer, differing only in the `Reason:` line
 * ("Allow network access to download example.com into the requested /tmp
 * file?") — Codex has no separate on-screen dialog for network access; it is
 * the same "run a command" dialog with a network-flavoured reason. This
 * module therefore classifies both as `kind: "command"`; a caller that needs
 * to tell them apart can inspect `detail`'s `Reason:` text itself.
 *
 * A file edit/patch drops the `Environment:`/`Reason:`/`$ …` block for a diff
 * summary above the question, and asks "Would you like to make the following
 * edits?" instead; its option 2 reads "…for these files" rather than naming a
 * command:
 *
 *   • Added ~/drovr-codex-probe-edit.txt (+1 -0)
 *       1 +hello from codex edit
 *
 *   Would you like to make the following edits?
 *
 * › 1. Yes, proceed (y)
 *   2. Yes, and don't ask again for these files (a)
 *   3. No, and tell Codex what to do differently (esc)
 *
 *   Press enter to confirm or esc to cancel
 *
 * An MCP tool call is a different shape entirely — a labelled field list, up
 * to four options with an inline description, and its own footer:
 *
 *   Field 1/1
 *   Allow the drovrprobe MCP server to run tool "danger_tool"?
 *
 *   note: probe test
 *
 * › 1. Allow                   Run the tool and continue.
 *   2. Allow for this session  Run the tool and remember this choice for this session.
 *   3. Always allow            Run the tool and remember this choice for future tool calls.
 *   4. Cancel                  Cancel this tool call
 *   enter to submit | esc to cancel
 *
 * Never chosen, whatever the caller asks: any option that stores a rule
 * beyond this one approval — "…don't ask again…", "Allow for this session",
 * "Always allow". Only the plain "Yes, proceed" / "Allow" option is ever
 * pressed; there is no "always" scope for Codex the way Claude's
 * `permission-approval.ts` has one; approve-once is the only behaviour this
 * module offers, by design (FACTORY-106/FACTORY-107).
 */

type ApprovalClient = {
  agent: Pick<DrovrClient["agent"], "list" | "get" | "read" | "sendKeys">;
};

export type CodexPermissionKind = "command" | "file-edit" | "mcp-tool";

export interface CodexPermissionPrompt {
  kind: CodexPermissionKind;
  /** What the dialog is asking about: the reason + command (command), a one-line diff summary (file-edit), or "server.tool" (mcp-tool). */
  detail: string;
  options: string[];
  /** Index into `options` of the option under the cursor. */
  cursor: number;
  /** A hash of kind, detail and options: names this prompt, not the cursor position. */
  promptId: string;
}

/** A screen that looks like a Codex approval dialog but matches none of the three known shapes — reported, never guessed at. */
export interface UnrecognisedCodexPrompt {
  kind: "unrecognised";
  excerpt: string;
  /**
   * A hash of the excerpt with cursor glyphs stripped: names this SHAPE of
   * unrecognised dialog, not the individual sighting, so a host can count
   * sightings per fingerprint the same way `blocking-escalation.ts`'s
   * `fingerprint` does for Claude's `unknown` dialogs (FACTORY-388) — stable
   * across polls of the same dialog even while the cursor moves between its
   * options.
   */
  fingerprint: string;
}

export type CodexApprovalScreen = CodexPermissionPrompt | UnrecognisedCodexPrompt;

const OPTION = /^\s*(›\s*)?\d+\.\s+(.+?)\s*$/;
/** A wrapped option's continuation line: indented text with no number of its own. */
const CONTINUATION = /^\s+\S/;

const FOOTER_RUN = /^\s*Press enter to confirm or esc to cancel\s*$/;
const FOOTER_MCP = /^\s*enter to submit \| esc to cancel\s*$/;
const QUESTION_COMMAND = /^\s*Would you like to run the following command\?\s*$/;
const QUESTION_EDIT = /^\s*Would you like to make the following edits\?\s*$/;
const QUESTION_MCP = /^\s*Allow the (.+) MCP server to run tool "(.+)"\?\s*$/;
/** A generic tripwire: something approval-shaped is on screen even if the specific shape above did not match. */
const APPROVAL_TRIPWIRE = /Would you like to (run|make)|Field \d+\/\d+|enter to submit \| esc to cancel|Press enter to confirm or esc to cancel/;

interface OptionScan { options: string[]; cursor: number; end: number }

/** Collects a Codex dialog's numbered option list starting at `from`, folding a wrapped continuation line back into the option it continues — same technique as `permission-approval.ts`'s `classifyPermissionPrompt` (DROVR-41). */
function scanOptions(lines: readonly string[], from: number, footer: RegExp): OptionScan | undefined {
  const options: string[] = [];
  let cursor = -1;
  let end = from;
  for (; end < lines.length; end++) {
    const line = lines[end]!;
    const match = OPTION.exec(line);
    if (match) {
      if (match[1]) cursor = options.length;
      options.push(match[2]!);
      continue;
    }
    const continuation = options.length > 0 && CONTINUATION.test(line) && !footer.test(line);
    if (!continuation) break;
    options[options.length - 1] = `${options[options.length - 1]} ${line.trim()}`;
  }
  return options.length >= 2 && cursor >= 0 ? { options, cursor, end } : undefined;
}

function findOptionsStart(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i++) if (OPTION.test(lines[i]!)) return i;
  return -1;
}

const excerptOf = (screen: string): string => screen.trim().split("\n").slice(-16).join("\n");
const flatten = (lines: readonly string[]): string => lines.join(" ").replace(/\s+/g, " ").trim();
const hashOf = (parts: unknown): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

/**
 * A cursor glyph (`›`, `❯`), replaced with a space rather than stripped —
 * Codex pads a non-cursor option line with a leading space in the glyph's
 * place (see `pane-mcp-tool.txt`), so an in-place swap is what keeps
 * `fingerprintOf` identical when the cursor moves to a DIFFERENT option, not
 * just when it sits still: stripping the glyph entirely would leave the
 * cursor's own line shorter than every other option line, changing the hash.
 */
const CURSOR_GLYPH = /[›❯]/g;
const fingerprintOf = (excerpt: string): string => hashOf(excerpt.replace(CURSOR_GLYPH, " "));
function unrecognisedOf(text: string): UnrecognisedCodexPrompt {
  const excerpt = excerptOf(text);
  return { kind: "unrecognised", excerpt, fingerprint: fingerprintOf(excerpt) };
}

/** The short option label before its padded inline description, e.g. `"Allow for this session  Run the tool…"` -> `"Allow for this session"`. Codex's MCP-tool dialog is the only shape that pads a description onto the option line. */
function mcpLabel(option: string): string {
  return option.split(/ {2,}/)[0]!.trim();
}

/** Codex's tool-approval dialog on a screen: a known kind, an unrecognised approval-ish screen, or undefined for anything else (including nothing at all). */
export function classifyCodexApprovalScreen(raw: string): CodexApprovalScreen | undefined {
  const text = stripTerminalEscapes(raw);
  const lines = text.split(/\r?\n/);

  const commandQ = lines.findIndex((line) => QUESTION_COMMAND.test(line));
  if (commandQ >= 0) {
    const optionsStart = findOptionsStart(lines, commandQ + 1);
    const scan = optionsStart >= 0 ? scanOptions(lines, optionsStart, FOOTER_RUN) : undefined;
    const footerNearby = scan && lines.slice(scan.end, scan.end + 3).some((line) => FOOTER_RUN.test(line));
    if (!scan || !footerNearby || !/^Yes, proceed\b/.test(scan.options[0]!) || !scan.options.some((option) => /^No\b/.test(option))) {
      return unrecognisedOf(text);
    }
    const between = flatten(lines.slice(commandQ + 1, optionsStart));
    const reason = /Reason:\s*(.+?)(?:\s*\$\s|$)/.exec(between)?.[1]?.trim();
    const command = /\$\s+(.+)$/.exec(between)?.[1]?.trim();
    const detail = [reason, command ? `$ ${command}` : undefined].filter((part): part is string => !!part).join(" — ") || between;
    return { kind: "command", detail, options: scan.options, cursor: scan.cursor, promptId: hashOf(["command", detail, scan.options]) };
  }

  const editQ = lines.findIndex((line) => QUESTION_EDIT.test(line));
  if (editQ >= 0) {
    const optionsStart = findOptionsStart(lines, editQ + 1);
    const scan = optionsStart >= 0 ? scanOptions(lines, optionsStart, FOOTER_RUN) : undefined;
    const footerNearby = scan && lines.slice(scan.end, scan.end + 3).some((line) => FOOTER_RUN.test(line));
    if (!scan || !footerNearby || !/^Yes, proceed\b/.test(scan.options[0]!) || !scan.options.some((option) => /^No\b/.test(option))) {
      return unrecognisedOf(text);
    }
    // The diff summary is Codex's own tool-call cell ("• Added/Updated/Deleted
    // …"), not the whole preceding user turn — walk back from the question to
    // the nearest such bullet, not to the last transcript separator.
    let summaryStart = -1;
    for (let i = editQ - 1; i >= 0; i--) if (/^\s*•\s/.test(lines[i]!)) { summaryStart = i; break; }
    const detail = summaryStart < 0
      ? "an unlabelled edit"
      : flatten(lines.slice(summaryStart, editQ).filter((line) => line.trim() !== ""));
    return { kind: "file-edit", detail, options: scan.options, cursor: scan.cursor, promptId: hashOf(["file-edit", detail, scan.options]) };
  }

  const mcpQ = lines.findIndex((line) => QUESTION_MCP.test(line));
  if (mcpQ >= 0) {
    const match = QUESTION_MCP.exec(lines[mcpQ]!)!;
    const optionsStart = findOptionsStart(lines, mcpQ + 1);
    const scan = optionsStart >= 0 ? scanOptions(lines, optionsStart, FOOTER_MCP) : undefined;
    const footerNearby = scan && lines.slice(scan.end, scan.end + 2).some((line) => FOOTER_MCP.test(line));
    if (!scan || !footerNearby || mcpLabel(scan.options[0]!) !== "Allow" || !scan.options.some((option) => mcpLabel(option) === "Cancel")) {
      return unrecognisedOf(text);
    }
    const detail = `${match[1]!.trim()}.${match[2]!.trim()}`;
    return { kind: "mcp-tool", detail, options: scan.options, cursor: scan.cursor, promptId: hashOf(["mcp-tool", detail, scan.options]) };
  }

  return APPROVAL_TRIPWIRE.test(text) ? unrecognisedOf(text) : undefined;
}

/** The option index that approves once and nothing more — never a stored-rule, session, or "always" option. -1 when the dialog has none, which the caller must treat as unanswerable, not as "press option 1 anyway". */
export function onceOptionIndex(prompt: CodexPermissionPrompt): number {
  if (prompt.kind === "mcp-tool") return prompt.options.findIndex((option) => mcpLabel(option) === "Allow");
  return prompt.options.findIndex((option) => /^Yes, proceed\b/.test(option));
}

function keysFor(prompt: CodexPermissionPrompt, target: number): string[] {
  const step = target > prompt.cursor ? "down" : "up";
  return [...Array.from({ length: Math.abs(target - prompt.cursor) }, () => step), "enter"];
}

interface PaneBase {
  paneId: string;
  label: string | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
}

export interface PendingCodexApproval extends CodexPermissionPrompt, PaneBase {}
export interface UnrecognisedCodexPane extends UnrecognisedCodexPrompt, PaneBase {}

const readScreen = (client: ApprovalClient, paneId: string): Promise<string> =>
  client.agent.read({ target: paneId, source: "visible", strip_ansi: true }).then((read) => read.read.text);

export interface ScanCodexApprovalsOptions extends PaneReadDeadlineOptions {}

export interface ScanCodexApprovalsResult {
  pending: PendingCodexApproval[];
  /** An approval-shaped screen that matched none of the three known dialogs. Never answered — see the module doc. */
  unrecognised: UnrecognisedCodexPane[];
  unreadable: UnreadablePane[];
}

/**
 * Every Codex pane showing a tool-approval prompt. Filtered to
 * `agent.agent === "codex"` only — a Claude pane is never touched by this
 * module, and a Codex pane is never touched by `permission-approval.ts`'s
 * Claude functions, so enabling this for one vendor cannot change the other's
 * behaviour. Mirrors `scanPendingPermissions`'s shape and per-pane read
 * deadline (default 1500ms; reads run in parallel).
 */
export async function scanPendingCodexApprovals(client: ApprovalClient, options: ScanCodexApprovalsOptions = {}): Promise<ScanCodexApprovalsResult> {
  const { agents } = await client.agent.list();
  const found = await Promise.all(agents.filter((agent) => agent.agent === "codex").map(async (agent) => {
    const base: PaneBase = {
      paneId: agent.pane_id,
      label: agent.name ?? undefined,
      sessionId: agent.agent_session?.kind === "id" ? agent.agent_session.value : undefined,
      cwd: agent.cwd ?? undefined,
    };
    const read = await readPaneWithDeadline(client, agent.pane_id, options);
    if (read.kind !== "ok") return { unreadable: { ...base, herdrStatus: agent.agent_status, reason: read.kind, detail: read.detail } };
    const screen = classifyCodexApprovalScreen(read.screen);
    if (screen === undefined) return {};
    return screen.kind === "unrecognised"
      ? { unrecognised: { ...screen, ...base } }
      : { pending: { ...screen, ...base } };
  }));
  return {
    pending: found.flatMap((r) => (r.pending ? [r.pending] : [])),
    unrecognised: found.flatMap((r) => (r.unrecognised ? [r.unrecognised] : [])),
    unreadable: found.flatMap((r) => (r.unreadable ? [r.unreadable] : [])),
  };
}

export interface ApproveCodexApprovalRequest {
  paneId: string;
  /** The `promptId` the caller saw; a different prompt on screen is refused. */
  promptId: string;
  /** Who approved: recorded in the audit, never empty. */
  operator: string;
  /** JSONL audit file — the SAME file Claude lizard mode (`permission-approval.ts`) writes to; records carry `vendor: "codex"` so a shared reader can tell them apart. */
  auditPath: string;
}

export type ApproveCodexApprovalRefusalReason =
  | "invalid-operator"
  | "no-prompt"
  /** The screen shows a different prompt than the one the caller saw. */
  | "prompt-changed"
  /** The screen shows an approval-shaped dialog this module cannot parse into a known kind. Never guessed at. */
  | "unrecognised"
  /** The dialog has no plain approve-once option (every option stores a rule, or the shape is otherwise unanswerable). */
  | "option-missing"
  | "audit-failed"
  | "not-cleared"
  | "keys-failed"
  | "verify-failed";

export type ApproveCodexApprovalResult =
  | { ok: true; attemptId: string; kind: CodexPermissionKind; detail: string }
  | { ok: false; attemptId: string; reason: ApproveCodexApprovalRefusalReason; detail: string };

const AUDIT_DETAIL_CHARS = 500;

/**
 * Approve the prompt the caller saw, and only that prompt, always with the
 * plain approve-once option — the Codex twin of `permission-approval.ts`'s
 * `approvePermission`, reusing its `PermissionApprovalDeps` (audit-first,
 * re-read-and-refuse-a-changed-prompt, verify-cleared) so both vendors write
 * the same shape of guarantee to the same audit file.
 */
export async function approveCodexApproval(
  client: ApprovalClient,
  request: ApproveCodexApprovalRequest,
  overrides: Partial<PermissionApprovalDeps> = {},
): Promise<ApproveCodexApprovalResult> {
  const deps = { ...defaultDeps, ...overrides };
  const attemptId = randomUUID();
  const agent = await client.agent.get(request.paneId).then((got) => got.agent, () => undefined);
  const record = (fields: Record<string, unknown>) => JSON.stringify({
    ts: deps.now().toISOString(),
    attemptId,
    vendor: "codex",
    operator: request.operator,
    paneId: request.paneId,
    label: agent?.name ?? undefined,
    sessionId: agent?.agent_session?.kind === "id" ? agent.agent_session.value : undefined,
    promptId: request.promptId,
    scope: "once",
    ...fields,
  }) + "\n";
  const refuse = async (reason: ApproveCodexApprovalRefusalReason, detail: string, screen?: CodexApprovalScreen): Promise<ApproveCodexApprovalResult> => {
    await deps.appendAudit(request.auditPath, record({
      outcome: reason, detail,
      ...(screen ? {
        kind: screen.kind,
        screenDetail: screen.kind === "unrecognised" ? screen.excerpt.slice(0, AUDIT_DETAIL_CHARS) : screen.detail.slice(0, AUDIT_DETAIL_CHARS),
        ...(screen.kind === "unrecognised" ? { fingerprint: screen.fingerprint } : {}),
      } : {}),
    })).catch(() => undefined);
    return { ok: false, attemptId, reason, detail };
  };

  if (!request.operator.trim()) return refuse("invalid-operator", "an approval must name its operator");
  const screen = classifyCodexApprovalScreen(await readScreen(client, request.paneId).catch(() => ""));
  if (screen === undefined) return refuse("no-prompt", `pane ${request.paneId} shows no Codex approval prompt`);
  if (screen.kind === "unrecognised") {
    return refuse("unrecognised", `pane ${request.paneId} shows an approval-shaped Codex dialog this module cannot parse; a human must answer it`, screen);
  }
  if (screen.promptId !== request.promptId) {
    return refuse("prompt-changed", `pane ${request.paneId} now shows a different prompt (${screen.promptId}); list again and approve that one`, screen);
  }
  const target = onceOptionIndex(screen);
  if (target < 0) return refuse("option-missing", `the prompt offers no plain approve-once option (options: ${JSON.stringify(screen.options)})`, screen);

  const shown = { kind: screen.kind, detail: screen.detail.slice(0, AUDIT_DETAIL_CHARS), option: screen.options[target] };
  try {
    await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "approving" }));
  } catch (error) {
    return { ok: false, attemptId, reason: "audit-failed", detail: `audit not written, nothing pressed: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    await client.agent.sendKeys({ target: request.paneId, keys: keysFor(screen, target) });
  } catch (error) {
    const detail = `whether a key may have reached the pane is unknown: ${error instanceof Error ? error.message : String(error)}`;
    await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "keys-failed", detail })).catch(() => undefined);
    return { ok: false, attemptId, reason: "keys-failed", detail };
  }

  try {
    const deadline = deps.now().getTime() + deps.verifyTimeoutMs;
    for (;;) {
      const still = classifyCodexApprovalScreen(await readScreen(client, request.paneId).catch(() => ""));
      if (!still || still.kind === "unrecognised" || still.promptId !== request.promptId) {
        await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "approved" })).catch(() => undefined);
        return { ok: true, attemptId, kind: screen.kind, detail: screen.detail };
      }
      if (deps.now().getTime() >= deadline) {
        await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "not-cleared" })).catch(() => undefined);
        return { ok: false, attemptId, reason: "not-cleared", detail: `keys were sent but pane ${request.paneId} still shows the prompt` };
      }
      await deps.wait(deps.pollMs);
    }
  } catch (error) {
    const detail = `keys were sent but whether pane ${request.paneId} shows the prompt is unknown: ${error instanceof Error ? error.message : String(error)}`;
    await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "verify-failed", detail })).catch(() => undefined);
    return { ok: false, attemptId, reason: "verify-failed", detail };
  }
}

export interface AutoAnswerCodexApprovalsOptions {
  /** JSONL audit file, forwarded to every `approveCodexApproval` call and to every unrecognised-prompt log line. */
  auditPath: string;
  /** Recorded as the audit operator on every attempt. Default lets an unattended pass be told apart from a human's. */
  operator?: string;
  /** Deadline for the whole per-pane `approveCodexApproval` attempt; see `AutoAnswerPermissionsOptions.readTimeoutMs` in `permission-approval.ts` for the same caveat: a `timeout` result means the outcome is UNKNOWN, not "nothing pressed". */
  readTimeoutMs?: number;
}

interface AutoAnswerBase {
  paneId: string;
  label: string | undefined;
}

export type AutoAnswerCodexApprovalResult =
  | (AutoAnswerBase & { outcome: "answered"; kind: CodexPermissionKind; detail: string })
  | (AutoAnswerBase & { outcome: "skipped"; reason: string })
  /** Logged to the audit trail (outcome `"unrecognised"`), never answered — a human must look at this pane. `fingerprint` names the dialog's shape, for sighting counts (FACTORY-388). */
  | (AutoAnswerBase & { outcome: "unrecognised"; excerpt: string; fingerprint: string })
  | (AutoAnswerBase & { outcome: "failed"; reason: string; detail: string });

const DEFAULT_AUTO_OPERATOR = "drovr-auto";
const AUTO_ANSWER_TIMEOUT = Symbol("codex-auto-answer-timeout");

/**
 * One unattended pass over every Codex pane's pending approval prompt: press
 * the plain approve-once option and nothing else. A prompt with no such
 * option is `skipped` before `approveCodexApproval` is ever called, so no
 * `approving` audit record is written for it — same rule as
 * `autoAnswerPermissions`. An unrecognised approval-shaped screen is NEVER
 * answered: it is logged to the audit trail with `outcome: "unrecognised"`
 * (so it is never silently dropped — the ticket's "never skip silently") and
 * reported back the same way, for a human to act on. One pane throwing, or
 * missing `readTimeoutMs`, is `failed` for that pane alone.
 */
export async function autoAnswerCodexApprovals(
  client: ApprovalClient,
  options: AutoAnswerCodexApprovalsOptions,
): Promise<AutoAnswerCodexApprovalResult[]> {
  const operator = options.operator ?? DEFAULT_AUTO_OPERATOR;
  const deps = defaultDeps;
  const scan = await scanPendingCodexApprovals(client);

  const unrecognised = scan.unrecognised.map(async (pane): Promise<AutoAnswerCodexApprovalResult> => {
    const line = JSON.stringify({
      ts: deps.now().toISOString(),
      attemptId: randomUUID(),
      vendor: "codex",
      operator,
      paneId: pane.paneId,
      label: pane.label,
      sessionId: pane.sessionId,
      scope: "once",
      outcome: "unrecognised",
      fingerprint: pane.fingerprint,
      detail: pane.excerpt.slice(0, AUDIT_DETAIL_CHARS),
    }) + "\n";
    await deps.appendAudit(options.auditPath, line).catch(() => undefined);
    return { paneId: pane.paneId, label: pane.label, outcome: "unrecognised", excerpt: pane.excerpt, fingerprint: pane.fingerprint };
  });

  const pending = scan.pending.map(async (approval): Promise<AutoAnswerCodexApprovalResult> => {
    const base = { paneId: approval.paneId, label: approval.label };
    try {
      const target = onceOptionIndex(approval);
      if (target < 0) {
        return { ...base, outcome: "skipped", reason: `no plain approve-once option on this ${approval.kind} prompt (options: ${JSON.stringify(approval.options)})` };
      }
      const attempt = approveCodexApproval(client, {
        paneId: approval.paneId,
        promptId: approval.promptId,
        operator,
        auditPath: options.auditPath,
      });
      attempt.catch(() => undefined);
      let result: ApproveCodexApprovalResult | typeof AUTO_ANSWER_TIMEOUT;
      if (options.readTimeoutMs === undefined) {
        result = await attempt;
      } else {
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<typeof AUTO_ANSWER_TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(AUTO_ANSWER_TIMEOUT), options.readTimeoutMs);
        });
        try {
          result = await Promise.race([attempt, deadline]);
        } finally {
          clearTimeout(timer!);
        }
      }
      if (result === AUTO_ANSWER_TIMEOUT) {
        return {
          ...base, outcome: "failed", reason: "timeout",
          detail: `approveCodexApproval did not return within ${options.readTimeoutMs}ms; it is still running and the outcome is unknown — check the audit log before retrying this pane`,
        };
      }
      if (result.ok) return { ...base, outcome: "answered", kind: result.kind, detail: result.detail };
      if (
        result.reason === "audit-failed" || result.reason === "not-cleared" ||
        result.reason === "invalid-operator" || result.reason === "keys-failed" || result.reason === "verify-failed"
      ) {
        return { ...base, outcome: "failed", reason: result.reason, detail: result.detail };
      }
      return { ...base, outcome: "skipped", reason: result.detail };
    } catch (error) {
      return { ...base, outcome: "failed", reason: "unexpected-error", detail: error instanceof Error ? error.message : String(error) };
    }
  });

  return Promise.all([...pending, ...unrecognised]);
}
