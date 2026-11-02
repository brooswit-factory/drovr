import type { ManagedAgentProvider } from "./agent-runtime.js";
export interface ManagedAgentWorkspace {
    provider: ManagedAgentProvider;
    cwd: string;
    unattended?: boolean;
    /** Explicit resident-agent intent; permits only this user's exact home, never its parents. */
    allowHomeWorkspace?: boolean;
}
/**
 * Prepare a caller-owned workspace after creation and before launch. AGY trust
 * is exact-path settings state, independent of permission-prompt CLI flags.
 * Calls are serialized within this process; settingsPath is a fixture override.
 */
export declare function prepareManagedAgentWorkspace(workspace: ManagedAgentWorkspace, settingsPath?: string): Promise<void>;
