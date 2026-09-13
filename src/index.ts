export const DROVR_PACKAGE_NAME = "@brooswit/drovr";

export {
  ProviderAvailabilityRegistry,
  processProviderAvailability,
  selectAvailableProvider,
  runWithProviderFallback,
  type ProviderAccount,
  type ProviderQuotaRefusal,
  type ProviderAvailability,
  type ProviderSelection,
  type ProviderAttemptResult,
  type ProviderFallbackResult,
} from "./provider-fallback.js";
export {
  classifySessionLimitText,
  detectSessionLimitRefusal,
  type SessionLimitOutcome,
  type SessionLimitRefusal,
} from "./session-limit.js";

export { DrovrClient, type DrovrClientOptions } from "./drovr-client.js";
export { startManagedAgent, AgentShellReadinessError, type AgentStartOptions, type ShellReadinessDiagnostics } from "./agent-start.js";
export {
  ManagedConversationRunner,
  runConversationProcess,
  type ManagedConversationRunnerOptions,
  type ManagedConversationResult,
  type RunProcess,
} from "./managed-conversation.js";
export { prepareManagedAgentWorkspace, type ManagedAgentWorkspace } from "./managed-workspace.js";
export {
  buildAgentStartParams,
  managedAgentProviderOfProcess,
  checkManagedAgentArgv,
  parseCodexMcpInventory,
  inventoryCodexMcpServers,
  type ManagedAgentProvider,
  type ManagedAgentProcess,
  type ManagedAgentArgvCheck,
  type ManagedAgentLaunch,
  type ClaudeAgentLaunch,
  type CodexAgentLaunch,
  type AgyAgentLaunch,
  type McpServerLaunchConfig,
  type DisabledMcpServer,
  type CodexMcpInventory,
  type CodexMcpInventoryProbeResult,
} from "./agent-runtime.js";
export {
  resolveManagedAgent,
  promptManagedAgent,
  closeManagedAgent,
  type ManagedAgentIdentity,
  type ManagedAgentResolution,
} from "./managed-agent.js";
export {
  type CallIdentity,
  type ChokePoint,
  type Invoke,
  passThroughChokePoint,
} from "./choke-point.js";
export {
  type Correction,
  type CorrectionContext,
  type CorrectionRegistry,
  createCorrectionChokePoint,
  defaultCorrections,
} from "./corrections.js";

// Re-exported so a migrated consumer never has to import from both
// drovr and @brooswit/herdr-sdk for the pieces DrovrClient hands back
// unchanged: error types (HerdrError, isTimeout), the subscription handle,
// and the SDK's own generated/typed-escape-hatch types.
export * from "@brooswit/herdr-sdk";
