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
/** Claude's tool-permission dialog on a screen, or undefined for anything else. */
export declare function classifyPermissionPrompt(raw: string): PermissionPrompt | undefined;
/**
 * `once` answers "Yes". `always` answers the "Yes, and …" option that
 * stores a rule; Claude words it "always allow … from this project", so it
 * outlives the session and is off unless a caller asks for it by name.
 */
export type PermissionScope = "once" | "always";
export interface PendingPermission extends PermissionPrompt {
    paneId: string;
    label: string | undefined;
    sessionId: string | undefined;
    cwd: string | undefined;
}
/**
 * Every Claude pane showing a tool-permission prompt. Every Claude pane's
 * screen is read, not only those herdr marks blocked: a dialog herdr reports
 * as idle is exactly what Drovr exists to catch.
 */
export declare function listPendingPermissions(client: ApprovalClient): Promise<PendingPermission[]>;
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
export type ApprovePermissionRefusalReason = "invalid-operator" | "no-prompt"
/** The screen shows a different prompt than the one the operator saw. */
 | "prompt-changed" | "option-missing"
/** The audit record could not be written, so nothing was pressed. */
 | "audit-failed"
/** Keys were sent but the same prompt is still on screen. */
 | "not-cleared";
export type ApprovePermissionResult = {
    ok: true;
    attemptId: string;
    tool: string;
    request: string;
    scope: PermissionScope;
} | {
    ok: false;
    attemptId: string;
    reason: ApprovePermissionRefusalReason;
    detail: string;
};
export interface PermissionApprovalDeps {
    appendAudit(path: string, line: string): Promise<void>;
    now(): Date;
    wait(ms: number): Promise<void>;
    verifyTimeoutMs: number;
    pollMs: number;
}
/**
 * Approve the prompt the operator saw, and only that prompt. The screen is
 * re-read first and a changed prompt is refused, so an approval can never land
 * on a prompt that appeared after the operator looked. An audit record is
 * written before any key is sent, and a second one with the outcome after.
 */
export declare function approvePermission(client: ApprovalClient, request: ApprovePermissionRequest, overrides?: Partial<PermissionApprovalDeps>): Promise<ApprovePermissionResult>;
export {};
