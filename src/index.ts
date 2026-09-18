export const DROVR_PACKAGE_NAME = "@brooswit/drovr";
export { ManagedConversationLifecycle, type ManagedConversationLifecycleOptions, type ManagedConversationMessageOptions, type ManagedConversationCommitContext } from "./managed-conversation-lifecycle.js";
export { ManagedHerdrLifecycle, type ManagedHerdrIdentity, type ManagedHerdrLifecycleOptions, type ManagedHerdrStartRequest, type ManagedHerdrResult } from "./managed-herdr-lifecycle.js";
export { readNativeTranscript, readClaudeTranscriptTail, nativeTranscriptReply, NativeTranscriptUnavailableError, type NativeTranscriptOptions, type ClaudeTranscriptTail } from "./native-transcript.js";
export {
  createResidentAgentMessenger,
  ClaudeResidentMessenger,
  ResidentMessageRefusal,
  listClaudeBackgroundSessions,
  openClaudeAttach,
  claudeResidentActivity,
  type ClaudeResidentActivity,
  RESIDENT_MESSAGE_MAX_CHARS,
  type ResidentAgentTarget,
  type ResidentAgentMessenger,
  type ResidentMessageOptions,
  type ResidentMessageResult,
  type ResidentMessageRefusalReason,
  type ResidentTerminal,
  type ClaudeBackgroundListing,
  type ClaudeResidentDeps,
} from "./resident-agent.js";
export {
  deliverToResident,
  type ChannelAck,
  type ChannelProof,
  type ResidentDelivery,
  type ResidentDeliveryDeps,
  type ResidentDeliveryOptions,
} from "./resident-delivery.js";
export { ManagedConversationSession, HANDOFF_ACK, HANDOFF_CHUNK_CHARS, type ConversationIdentity, type ConversationSessionOptions } from "./conversation-session.js";
export { providerSetupSeed, applyProviderSetupSeed, type ProviderSetupFile } from "./provider-setup.js";

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
  ManagedConversationQuotaError,
  AgyDeniedActionsError,
  runConversationProcess,
  type ManagedConversationRunnerOptions,
  type ManagedConversationResult,
  type RunProcess,
} from "./managed-conversation.js";
export { prepareManagedAgentWorkspace, type ManagedAgentWorkspace } from "./managed-workspace.js";
export {
  mcpAccessProvisioning,
  notificationSupport,
  applyMcpAccess,
  setMcpAccess,
  switchProviderMcpAccess,
  awaitIdentityRelease,
  IdentityStillHeldError,
  realMcpSettingsIo,
  type McpServerAccess,
  type McpAccessDeclaration,
  type McpRuntime,
  type McpRestartKind,
  type NotificationSupport,
  type RunningMcpAccess,
  type McpAccessProvisioning,
  type McpAccessApplied,
  type McpAccessChange,
  type McpSettingsEdit,
  type McpSettingsIo,
  type McpRestartDeps,
  type IdentityReleaseOptions,
} from "./mcp-access.js";
export {
  buildAgentStartParams,
  buildProviderLaunchArgs,
  developmentChannelsOf,
  mergeDevelopmentChannels,
  managedAgentProviderOfProcess,
  checkManagedAgentArgv,
  parseCodexMcpInventory,
  inventoryCodexMcpServers,
  type ManagedAgentProvider,
  type ProviderLaunchInputs,
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
export { prepareAgyHome, type AgyStdioServer } from "./agy-home.js";
export {
  launchBackgroundSession,
  buildBackgroundLaunchArgv,
  parseBackgroundLaunchId,
  type BackgroundLaunchRequest,
  type BackgroundLaunchResult,
  type BackgroundLaunchRefusal,
  type BackgroundLaunchDeps,
} from "./background-launch.js";
export {
  classifyBlockingText,
  classifyClaudeTranscriptRecord,
  probeClaudeDaemon,
  daemonBlockingCondition,
  claudeLoggedIn,
  plainOutputEnv,
  stripTerminalEscapes,
  type BlockingCondition,
  type BlockingConditionKind,
  type ClaudeDaemonState,
  type ClaudeDaemonProbeDeps,
} from "./blocking-conditions.js";
export {
  startClaudeLogin,
  parseClaudeLoginUrl,
  type ClaudeLoginSession,
  type ClaudeLoginResult,
  type ClaudeLoginTerminal,
  type ClaudeLoginDeps,
  type StartClaudeLoginOptions,
} from "./claude-login.js";
export {
  hostResident,
  listResidents,
  stopResident,
  classifyStartupPrompt,
  keysToChoose,
  buildResidentClaudeArgs,
  RESIDENT_WORKSPACE_PREFIX,
  type HostResidentRequest,
  type HostResidentResult,
  type HostResidentRefusalReason,
  type ResidentHostOptions,
  type ResidentListing,
  type StartupPrompt,
  type StopResidentResult,
} from "./resident-host.js";
export {
  classifyPermissionPrompt,
  listPendingPermissions,
  approvePermission,
  type PermissionPrompt,
  type PermissionScope,
  type PendingPermission,
  type ApprovePermissionRequest,
  type ApprovePermissionResult,
  type ApprovePermissionRefusalReason,
  type PermissionApprovalDeps,
} from "./permission-approval.js";
export {
  listBlockingPrompts,
  classifyBlockingScreen,
  type BlockingPrompt,
  type BlockingPromptKind,
} from "./blocking-prompts.js";
