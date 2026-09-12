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

export type ManagedAgentResolution =
  | { status: "found"; matchedBy: "pane" | "workspace"; agent: results.AgentInfo }
  | { status: "missing"; reason: string }
  | { status: "ambiguous"; reason: string; candidates: readonly results.AgentInfo[] };

const matchesProvider = (agent: results.AgentInfo, provider: ManagedAgentProvider): boolean =>
  agent.agent === provider;

const matchesIdentity = (agent: results.AgentInfo, identity: ManagedAgentIdentity): boolean =>
  agent.cwd === identity.cwd && (!identity.provider || matchesProvider(agent, identity.provider));

/**
 * Resolve a logical managed agent without depending on Herdr's mutable alias.
 * A cached pane ID wins while it still belongs to the expected provider and
 * workspace; otherwise provider + workspace recover the current live handle.
 */
export async function resolveManagedAgent(
  client: DrovrClient,
  identity: ManagedAgentIdentity,
): Promise<ManagedAgentResolution> {
  const { agents } = await client.agent.list();

  if (identity.paneId) {
    const pane = agents.find((agent) => agent.pane_id === identity.paneId);
    if (pane && matchesIdentity(pane, identity)) return { status: "found", matchedBy: "pane", agent: pane };
  }

  const workspace = agents.filter((agent) => matchesIdentity(agent, identity));
  if (workspace.length === 1) return { status: "found", matchedBy: "workspace", agent: workspace[0]! };
  if (workspace.length > 1) {
    return {
      status: "ambiguous",
      reason: "multiple live agents match the expected provider and workspace",
      candidates: workspace,
    };
  }

  return { status: "missing", reason: "no live agent matches the expected provider and workspace" };
}

export async function promptManagedAgent(
  client: DrovrClient,
  identity: ManagedAgentIdentity,
  text: string,
): Promise<{ resolution: ManagedAgentResolution; prompted?: results.AgentInfo }> {
  const resolution = await resolveManagedAgent(client, identity);
  if (resolution.status !== "found") return { resolution };
  const result = await client.agent.prompt({ target: resolution.agent.pane_id, text });
  return { resolution, prompted: result.agent };
}
