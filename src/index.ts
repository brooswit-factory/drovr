export const DROVR_PACKAGE_NAME = "@brooswit/drovr";

export { DrovrClient, type DrovrClientOptions } from "./drovr-client.js";
export {
  buildAgentStartParams,
  managedAgentProviderOfProcess,
  checkManagedAgentArgv,
  type ManagedAgentProvider,
  type ManagedAgentProcess,
  type ManagedAgentArgvCheck,
  type ManagedAgentLaunch,
  type ClaudeAgentLaunch,
  type CodexAgentLaunch,
  type McpServerLaunchConfig,
  type DisabledMcpServer,
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
