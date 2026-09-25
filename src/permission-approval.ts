import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { stripTerminalEscapes } from "./blocking-conditions.js";
import type { DrovrClient } from "./drovr-client.js";

/**
 * Approving a session's pending tool-permission prompt without a terminal.
 *
 * What this answers: Claude's "Do you want to proceed?" dialog, which a
 * session in a default or ask permission mode shows before a tool call and
 * then waits on. Measured on claude 2.1.277 in a herdr pane (2026-09-18):
 *
 *   ─────────────────────────────────────────
 *    Bash command
 *    Tip: auto mode handles these prompts for you — …
 *
 *      touch drovr-permission-probe.txt
 *      Create empty probe file
 *
 *    Do you want to proceed?
 *    ❯ 1. Yes
 *      2. Yes, and always allow access to /tmp/… from this project
 *      3. Yes, and switch to auto mode · auto mode handles these prompts for you
 *      4. No
 *
 *    Esc to cancel · Tab to amend
 *
 * What it cannot answer: an auto-mode classifier denial. That refuses the
 * tool call outright and leaves nothing on screen to approve; only a
 * permission rule the session reads at start can change it.
 *
 * Never chosen, whatever the caller asks: switching the session to auto mode.
 */

type ApprovalClient = {
  agent: Pick<DrovrClient["agent"], "list" | "get" | "read" | "sendKeys">;
};

export interface PermissionPrompt {
  /** The dialog's title line, e.g. "Bash command". */
  tool: string;
  /** What the tool will do, as the dialog shows it (a command, a path, a diff). */
  request: string;
  /** e.g. "Do you want to proceed?" */
  question: string;
  options: string[];
  /** Index into `options` of the option under the cursor. */
  cursor: number;
  /** A hash of tool, request, question and options: names this prompt, not the cursor position. */
  promptId: string;
}

const SEPARATOR = /^\s*─{10,}\s*$/;
const QUESTION = /^\s*(Do you want to .+\?)\s*$/;
const OPTION = /^\s*(❯\s*)?\d+\.\s+(.+?)\s*$/;
/** A wrapped option's continuation line: indented text with no number of its own. */
const CONTINUATION = /^\s+\S/;

/** Claude's tool-permission dialog on a screen, or undefined for anything else. */
export function classifyPermissionPrompt(raw: string): PermissionPrompt | undefined {
  const lines = stripTerminalEscapes(raw).split(/\r?\n/);
  const q = lines.findIndex((line) => QUESTION.test(line));
  if (q < 0) return undefined;
  const options: string[] = [];
  let cursor = -1;
  let end = q + 1;
  for (; end < lines.length; end++) {
    const line = lines[end]!;
    const match = OPTION.exec(line);
    if (match) {
      if (match[1]) cursor = options.length;
      options.push(match[2]!);
      continue;
    }
    // A long option can wrap onto a following physical line with no number
    // of its own, indented like the measured wrap. Fold it back into the
    // option it continues rather than treating it as the end of the list —
    // otherwise the footer check below looks at the wrong window and the
    // whole dialog reads as "not a prompt", which is worse than unanswered:
    // it becomes invisible to listPendingPermissions entirely. A blank
    // line, an unindented stray line, a fresh separator or question, or the
    // footer itself still ends the list.
    const continuation = options.length > 0 && CONTINUATION.test(line) && !SEPARATOR.test(line) && !QUESTION.test(line) && !/Esc to cancel/.test(line);
    if (!continuation) break;
    options[options.length - 1] = `${options[options.length - 1]} ${line.trim()}`;
  }
  if (options.length < 2 || cursor < 0 || options[0] !== "Yes" || !options.some((option) => /^No\b/.test(option))) return undefined;
  if (!lines.slice(end, end + 3).some((line) => /Esc to cancel/.test(line))) return undefined;
  let separator = -1;
  for (let i = q - 1; i >= 0; i--) if (SEPARATOR.test(lines[i]!)) { separator = i; break; }
  if (separator < 0) return undefined;
  const body = lines.slice(separator + 1, q).map((line) => line.trim()).filter((line) => line !== "" && !/^Tip:/.test(line));
  const tool = body[0];
  if (tool === undefined) return undefined;
  const request = body.slice(1).join("\n");
  const question = QUESTION.exec(lines[q]!)![1]!;
  const promptId = createHash("sha256").update(JSON.stringify([tool, request, question, options])).digest("hex").slice(0, 16);
  return { tool, request, question, options, cursor, promptId };
}

/**
 * `once` answers "Yes". `always` answers the "Yes, and …" option that
 * stores a rule; Claude words it "always allow … from this project", so it
 * outlives the session and is off unless a caller asks for it by name.
 */
export type PermissionScope = "once" | "always";

function optionFor(prompt: PermissionPrompt, scope: PermissionScope): number {
  if (scope === "once") return prompt.options.indexOf("Yes");
  return prompt.options.findIndex((option) => /^Yes, and\b/.test(option) && !/auto mode/i.test(option));
}

function keysFor(prompt: PermissionPrompt, target: number): string[] {
  const step = target > prompt.cursor ? "down" : "up";
  return [...Array.from({ length: Math.abs(target - prompt.cursor) }, () => step), "enter"];
}

export interface PendingPermission extends PermissionPrompt {
  paneId: string;
  label: string | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
}

const readScreen = (client: ApprovalClient, paneId: string): Promise<string> =>
  client.agent.read({ target: paneId, source: "visible", strip_ansi: true }).then((read) => read.read.text);

/**
 * Every Claude pane showing a tool-permission prompt. Every Claude pane's
 * screen is read, not only those herdr marks blocked: a dialog herdr reports
 * as idle is exactly what Drovr exists to catch.
 */
export async function listPendingPermissions(client: ApprovalClient): Promise<PendingPermission[]> {
  const { agents } = await client.agent.list();
  const pending = await Promise.all(agents.filter((agent) => agent.agent === "claude").map(async (agent) => {
    const prompt = classifyPermissionPrompt(await readScreen(client, agent.pane_id).catch(() => ""));
    return prompt === undefined ? [] : [{
      ...prompt,
      paneId: agent.pane_id,
      label: agent.name ?? undefined,
      sessionId: agent.agent_session?.kind === "id" ? agent.agent_session.value : undefined,
      cwd: agent.cwd ?? undefined,
    }];
  }));
  return pending.flat();
}

export interface ApprovePermissionRequest {
  paneId: string;
  /** The `promptId` the operator saw; a different prompt on screen is refused. */
  promptId: string;
  /** Who approved: recorded in the audit, never empty. */
  operator: string;
  scope?: PermissionScope;
  /** JSONL audit file; one record per attempt, and one more once keys were sent. */
  auditPath: string;
}

export type ApprovePermissionRefusalReason =
  | "invalid-operator"
  | "no-prompt"
  /** The screen shows a different prompt than the one the operator saw. */
  | "prompt-changed"
  | "option-missing"
  /** The audit record could not be written, so nothing was pressed. */
  | "audit-failed"
  /** Keys were sent but the same prompt is still on screen. */
  | "not-cleared";

export type ApprovePermissionResult =
  | { ok: true; attemptId: string; tool: string; request: string; scope: PermissionScope }
  | { ok: false; attemptId: string; reason: ApprovePermissionRefusalReason; detail: string };

export interface PermissionApprovalDeps {
  appendAudit(path: string, line: string): Promise<void>;
  now(): Date;
  wait(ms: number): Promise<void>;
  verifyTimeoutMs: number;
  pollMs: number;
}

const defaultDeps: PermissionApprovalDeps = {
  appendAudit: async (path, line) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, { mode: 0o600 });
  },
  now: () => new Date(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  verifyTimeoutMs: 5_000,
  pollMs: 250,
};

const AUDIT_REQUEST_CHARS = 500;

/**
 * Approve the prompt the operator saw, and only that prompt. The screen is
 * re-read first and a changed prompt is refused, so an approval can never land
 * on a prompt that appeared after the operator looked. An audit record is
 * written before any key is sent, and a second one with the outcome after.
 */
export async function approvePermission(
  client: ApprovalClient,
  request: ApprovePermissionRequest,
  overrides: Partial<PermissionApprovalDeps> = {},
): Promise<ApprovePermissionResult> {
  const deps = { ...defaultDeps, ...overrides };
  const attemptId = randomUUID();
  const scope = request.scope ?? "once";
  const agent = await client.agent.get(request.paneId).then((got) => got.agent, () => undefined);
  const record = (fields: Record<string, unknown>) => JSON.stringify({
    ts: deps.now().toISOString(),
    attemptId,
    operator: request.operator,
    paneId: request.paneId,
    label: agent?.name ?? undefined,
    sessionId: agent?.agent_session?.kind === "id" ? agent.agent_session.value : undefined,
    promptId: request.promptId,
    scope,
    ...fields,
  }) + "\n";
  const refuse = async (reason: ApprovePermissionRefusalReason, detail: string, prompt?: PermissionPrompt): Promise<ApprovePermissionResult> => {
    await deps.appendAudit(request.auditPath, record({
      outcome: reason, detail,
      ...(prompt ? { tool: prompt.tool, request: prompt.request.slice(0, AUDIT_REQUEST_CHARS) } : {}),
    })).catch(() => undefined);
    return { ok: false, attemptId, reason, detail };
  };

  if (!request.operator.trim()) return refuse("invalid-operator", "an approval must name its operator");
  const prompt = classifyPermissionPrompt(await readScreen(client, request.paneId).catch(() => ""));
  if (!prompt) return refuse("no-prompt", `pane ${request.paneId} shows no permission prompt`);
  if (prompt.promptId !== request.promptId) {
    return refuse("prompt-changed", `pane ${request.paneId} now shows a different prompt (${prompt.promptId}); list again and approve that one`, prompt);
  }
  const target = optionFor(prompt, scope);
  if (target < 0) return refuse("option-missing", `the prompt offers no option for scope ${scope}`, prompt);

  const shown = { tool: prompt.tool, request: prompt.request.slice(0, AUDIT_REQUEST_CHARS), option: prompt.options[target] };
  try {
    await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "approving" }));
  } catch (error) {
    return { ok: false, attemptId, reason: "audit-failed", detail: `audit not written, nothing pressed: ${error instanceof Error ? error.message : String(error)}` };
  }
  await client.agent.sendKeys({ target: request.paneId, keys: keysFor(prompt, target) });

  const deadline = deps.now().getTime() + deps.verifyTimeoutMs;
  for (;;) {
    const still = classifyPermissionPrompt(await readScreen(client, request.paneId).catch(() => ""));
    if (still?.promptId !== request.promptId) {
      await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "approved" })).catch(() => undefined);
      return { ok: true, attemptId, tool: prompt.tool, request: prompt.request, scope };
    }
    if (deps.now().getTime() >= deadline) {
      await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "not-cleared" })).catch(() => undefined);
      return { ok: false, attemptId, reason: "not-cleared", detail: `keys were sent but pane ${request.paneId} still shows the prompt` };
    }
    await deps.wait(deps.pollMs);
  }
}

export interface AutoAnswerPermissionsOptions {
  /** JSONL audit file, forwarded to every `approvePermission` call. */
  auditPath: string;
  /** Recorded as the audit operator on every attempt. Default lets an unattended pass be told apart from a human's. */
  operator?: string;
  /**
   * Deadline for the whole per-pane `approvePermission` attempt (not a single
   * read). A pane past it is `failed` with `reason: "timeout"`, never left
   * out of the results — but `approvePermission` is not cancelled, so a
   * `timeout` result means the outcome is UNKNOWN, not "nothing pressed":
   * the call keeps running and may still press keys and record `approved` in
   * the audit log after this function has already returned. Check the audit
   * log for a pane that timed out.
   */
  readTimeoutMs?: number;
}

interface AutoAnswerBase {
  paneId: string;
  label: string | undefined;
}

export type AutoAnswerPermissionResult =
  | (AutoAnswerBase & { outcome: "answered"; tool: string; request: string })
  | (AutoAnswerBase & { outcome: "skipped"; reason: string })
  | (AutoAnswerBase & { outcome: "failed"; reason: string; detail: string });

const DEFAULT_AUTO_OPERATOR = "drovr-auto";
const AUTO_ANSWER_TIMEOUT = Symbol("auto-answer-timeout");

/**
 * One unattended pass over every pending Claude permission prompt: press the
 * `scope: "always"` option, which is option 2 on the current dialog, and
 * nothing else. A prompt whose option 2 isn't that "Yes, and …" option is
 * skipped before `approvePermission` is ever called, so no "approving" audit
 * record is written for it. One pane throwing, or (with `readTimeoutMs` set)
 * missing its deadline, is caught and reported as `failed` for that pane; it
 * never fails the rest of the pass. A `timeout` failure does not mean nothing
 * was pressed — see `AutoAnswerPermissionsOptions.readTimeoutMs`.
 */
export async function autoAnswerPermissions(
  client: ApprovalClient,
  options: AutoAnswerPermissionsOptions,
): Promise<AutoAnswerPermissionResult[]> {
  const operator = options.operator ?? DEFAULT_AUTO_OPERATOR;
  const pending = await listPendingPermissions(client);
  return Promise.all(pending.map(async (permission): Promise<AutoAnswerPermissionResult> => {
    const base = { paneId: permission.paneId, label: permission.label };
    try {
      const target = optionFor(permission, "always");
      if (target !== 1) {
        return { ...base, outcome: "skipped", reason: target < 0
          ? `no "Yes, and …" stored-rule option on this prompt (options: ${JSON.stringify(permission.options)})`
          : `the stored-rule option is at position ${target + 1}, not option 2 (options: ${JSON.stringify(permission.options)})` };
      }
      const attempt = approvePermission(client, {
        paneId: permission.paneId,
        promptId: permission.promptId,
        operator,
        scope: "always",
        auditPath: options.auditPath,
      });
      attempt.catch(() => undefined);
      let result: ApprovePermissionResult | typeof AUTO_ANSWER_TIMEOUT;
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
          detail: `approvePermission did not return within ${options.readTimeoutMs}ms; it is still running and the outcome is unknown — it may still press keys and record "approved" in the audit log, check it before retrying this pane`,
        };
      }
      if (result.ok) return { ...base, outcome: "answered", tool: result.tool, request: result.request };
      if (result.reason === "audit-failed" || result.reason === "not-cleared" || result.reason === "invalid-operator") {
        return { ...base, outcome: "failed", reason: result.reason, detail: result.detail };
      }
      return { ...base, outcome: "skipped", reason: result.detail };
    } catch (error) {
      return { ...base, outcome: "failed", reason: "unexpected-error", detail: error instanceof Error ? error.message : String(error) };
    }
  }));
}
