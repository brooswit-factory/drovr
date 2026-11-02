import type { DrovrClient } from "./drovr-client.js";
/**
 * Every dialog a Claude pane is waiting on, so nothing hangs unseen.
 *
 * On 2026-09-18 two agents sat on a menu no one had met before ("Teach auto
 * mode about your environment?") until Brooswit noticed and answered by hand,
 * while herdr reported both panes idle or done. A host polls this, answers
 * what Drovr knows how to answer, and alerts a person on `unknown`.
 */
type ScanClient = {
    agent: Pick<DrovrClient["agent"], "list" | "read">;
};
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
}
/** What one screen is waiting on, or undefined when it waits on nothing. */
export declare function classifyBlockingScreen(raw: string): Pick<BlockingPrompt, "kind" | "name" | "excerpt"> | undefined;
/**
 * Every Claude pane waiting on a dialog. Every Claude pane's screen is read,
 * whatever herdr says its status is. A pane whose screen cannot be read is
 * skipped, never reported as blocked.
 */
export declare function listBlockingPrompts(client: ScanClient): Promise<BlockingPrompt[]>;
export {};
