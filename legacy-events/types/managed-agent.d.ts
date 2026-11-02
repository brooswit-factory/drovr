import type { results } from "@brooswit/herdr-sdk";
import type { DrovrClient } from "./drovr-client.js";
import type { ManagedAgentProvider } from "./agent-runtime.js";
export interface ManagedAgentIdentity {
    /** Workspace ownership boundary used to recover an agent whose alias was lost. */
    cwd: string;
    /** Optional when the caller is addressing existing work across a provider switch. */
    provider?: ManagedAgentProvider;
    /** Last observed stable pane handle, when the caller has persisted one. */
    paneId?: string;
}
export type ManagedAgentResolution = {
    status: "found";
    matchedBy: "pane" | "workspace";
    agent: results.AgentInfo;
} | {
    status: "missing";
    reason: string;
} | {
    status: "ambiguous";
    reason: string;
    candidates: readonly results.AgentInfo[];
};
/**
 * Resolve a logical managed agent without depending on Herdr's mutable alias.
 * A cached pane ID wins while it still belongs to the expected provider and
 * workspace; otherwise provider + workspace recover the current live handle.
 */
export declare function resolveManagedAgent(client: DrovrClient, identity: ManagedAgentIdentity): Promise<ManagedAgentResolution>;
export declare function promptManagedAgent(client: DrovrClient, identity: ManagedAgentIdentity, text: string): Promise<{
    resolution: ManagedAgentResolution;
    prompted?: results.AgentInfo;
}>;
export declare function closeManagedAgent(client: DrovrClient, identity: ManagedAgentIdentity): Promise<{
    resolution: ManagedAgentResolution;
    closed: boolean;
}>;
