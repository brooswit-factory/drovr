import type { ParamsOf } from "@brooswit/herdr-sdk";
export type ManagedAgentProvider = "claude" | "codex" | "agy";
export interface ManagedAgentProcess {
    argv?: readonly string[] | null;
    name?: string | null;
}
export declare function managedAgentProviderOfProcess(process: ManagedAgentProcess): ManagedAgentProvider | undefined;
export type ManagedAgentArgvCheck = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/**
 * Union development channel names in caller order, keeping the first mention of
 * each. Merging rather than replacing is what lets a request add a channel to a
 * launch that already configures others, without either side knowing the other.
 */
export declare function mergeDevelopmentChannels(...lists: readonly (readonly string[] | undefined)[]): readonly string[];
export declare function checkManagedAgentArgv(expected: readonly string[], observed: readonly string[]): ManagedAgentArgvCheck;
export interface McpServerLaunchConfig {
    name: string;
    url: string;
    headers?: Readonly<Record<string, string>>;
}
export interface DisabledMcpServer {
    name: string;
    transport: "stdio" | "streamable_http";
}
export interface CodexMcpInventoryProbeResult {
    exitCode: number;
    stdout: {
        toString(): string;
    } | string;
}
export type CodexMcpInventory = {
    ok: true;
    servers: DisabledMcpServer[];
} | {
    ok: false;
    reason: string;
};
export declare function parseCodexMcpInventory(output: string, excludedNames?: readonly string[]): DisabledMcpServer[];
export declare function inventoryCodexMcpServers(excludedNames?: readonly string[], probe?: () => CodexMcpInventoryProbeResult): CodexMcpInventory;
/**
 * What a caller configures for a session, in its own vocabulary: which MCP
 * configuration the session reads, and which MCP servers it must receive
 * notifications from. No field here names a provider or a CLI flag, so a
 * caller that only knows "this session talks to yappr" never learns Claude's
 * spelling for it.
 */
export interface ProviderLaunchInputs {
    /** MCP configuration file the session launches against. */
    mcpConfigPath?: string;
    /** MCP servers whose notifications must reach the session. */
    mcpNotificationServers?: readonly string[];
    /** Channel names a caller already holds spelled out; merged with the above. */
    developmentChannels?: readonly string[];
    /**
     * Servers from the workspace's own MCP file the session may start without
     * asking. Measured on claude 2.1.276: in an untrusted directory Claude
     * ignores the workspace's own approval file, and a background session sits
     * blocked on "New MCP server found in this project" until a human answers.
     * An approval given at launch holds regardless of trust.
     */
    mcpServersApproved?: readonly string[];
}
/**
 * Every channel a launch asks for: the ones named outright plus one per MCP
 * server whose notifications were requested, de-duplicated in caller order.
 */
export declare function developmentChannelsOf(inputs: ProviderLaunchInputs): readonly string[];
/**
 * Translate neutral launch inputs into one provider's CLI arguments. This is
 * the whole of Drovr's provider-flag knowledge for MCP and channels: a caller
 * that spawns a provider CLI itself appends these and spells nothing of its
 * own. Providers with no development-channel concept return no such flag
 * rather than refusing the caller.
 *
 * Each channel is its own `--dangerously-load-development-channels=server:x`.
 * The variadic space-separated form is not safe: measured on claude 2.1.276,
 * `claude --bg` reads the flag's value as the session's first prompt (its job
 * `intent`), so a launch with `... server:rocketr --bg` began its life with
 * the user turn "server:rocketr" and never registered the channel. Joined with
 * `=`, no argv splitter can take the value for a positional.
 */
export declare function buildProviderLaunchArgs(provider: ManagedAgentProvider, inputs: ProviderLaunchInputs): string[];
interface AgentLaunchBase {
    provider: ManagedAgentProvider;
    name: string;
    paneId: string;
    cwd: string;
    prompt: string;
    model?: string;
    timeoutMs?: number;
    /**
     * Provider-neutral MCP configuration file path. Callers state the intent once;
     * each provider adapter below decides whether and how to spell it on the CLI.
     */
    mcpConfigPath?: string;
    /**
     * Provider-neutral development channel names. Providers without a development
     * channel concept accept and ignore them rather than rejecting the caller.
     */
    developmentChannels?: readonly string[];
    /** MCP servers whose notifications must reach this agent; see ProviderLaunchInputs. */
    mcpNotificationServers?: readonly string[];
}
export interface ClaudeAgentLaunch extends AgentLaunchBase {
    provider: "claude";
    effort: string;
    /** Claude always launches against an explicit MCP configuration. */
    mcpConfigPath: string;
    permissionMode?: string;
}
export interface CodexAgentLaunch extends AgentLaunchBase {
    provider: "codex";
    mcpServers: readonly McpServerLaunchConfig[];
    disabledMcpServers?: readonly DisabledMcpServer[];
    trustWorkspace?: boolean;
    bypassApprovalsAndSandbox?: boolean;
}
export interface AgyAgentLaunch extends AgentLaunchBase {
    provider: "agy";
    /** Skip AGY permission prompts only when explicitly enabled by the caller. */
    skipPermissions?: boolean;
}
export type ManagedAgentLaunch = ClaudeAgentLaunch | CodexAgentLaunch | AgyAgentLaunch;
/**
 * Translate application intent into Herdr's low-level agent.start contract.
 * Herdr owns the pane and process; Drovr owns provider-specific CLI shape.
 */
export declare function buildAgentStartParams(launch: ManagedAgentLaunch): ParamsOf<"agent.start">;
export {};
