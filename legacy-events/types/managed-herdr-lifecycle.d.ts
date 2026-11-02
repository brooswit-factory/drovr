import type { results } from "@brooswit/herdr-sdk";
import { type ManagedAgentLaunch, type ManagedAgentProvider } from "./agent-runtime.js";
import { type AgentStartOptions } from "./agent-start.js";
import type { DrovrClient } from "./drovr-client.js";
import { type NativeTranscriptOptions } from "./native-transcript.js";
import { type ProviderAccount, type ProviderAvailabilityRegistry, type ProviderFallbackResult } from "./provider-fallback.js";
export interface ManagedHerdrIdentity {
    paneId: string;
    provider: ManagedAgentProvider;
    cwd: string;
    home?: string;
}
export interface ManagedHerdrLifecycleOptions {
    instanceId?: string;
    client: DrovrClient;
    cwd: string;
    current?: ManagedHerdrIdentity;
    availability?: ProviderAvailabilityRegistry;
    startOptions?: AgentStartOptions;
    wait?: (ms: number) => Promise<void>;
    acknowledgementTimeoutMs?: number;
    pollIntervalMs?: number;
    kickoffVerifyMs?: number;
    /** Native history reader injection; never supply terminal-screen text. */
    readTranscript?: (options: NativeTranscriptOptions) => Promise<string>;
}
export interface ManagedHerdrStartRequest {
    priority: readonly ProviderAccount[];
    label: string;
    /** Required to replace an existing worker; stale handles fail closed. */
    replacePaneId?: string;
    reason?: string;
    prepare: (provider: ManagedAgentProvider) => Promise<{
        /** Drovr overrides prompt and paneId for the transaction. */
        launch: ManagedAgentLaunch;
        env?: Record<string, string>;
        home?: string;
    }>;
    kickoff: (provider: ManagedAgentProvider) => string;
    /**
     * Provider-neutral MCP configuration file path. Supplied once per request and
     * applied to whichever provider wins selection; overrides the prepared launch.
     */
    mcpConfigPath?: string;
    /**
     * Provider-neutral development channel names. These are merged with whatever
     * the prepared launch already configures, so a request adds its channels
     * without dropping the launch's own. An empty list adds nothing.
     */
    developmentChannels?: readonly string[];
    /**
     * MCP servers whose notifications must reach the worker. Merged the same way;
     * Drovr, not the caller, knows how a provider names the resulting channel.
     */
    mcpNotificationServers?: readonly string[];
}
export type ManagedHerdrResult = ProviderFallbackResult<string> | {
    status: "blocked";
    reason: string;
    current: ManagedHerdrIdentity | undefined;
};
/** One instance per logical workspace. All mutations route to exact pane IDs. */
export declare class ManagedHerdrLifecycle {
    private readonly options;
    private freezeWatch;
    private active;
    private readonly nativeSessions;
    private readonly wait;
    private readonly availability;
    constructor(options: ManagedHerdrLifecycleOptions);
    get current(): ManagedHerdrIdentity | undefined;
    private exclusive;
    /** An established identity never falls back to another pane at the same cwd. */
    resolveCurrent(): Promise<results.AgentInfo | undefined>;
    prompt(text: string): Promise<results.AgentInfo | undefined>;
    stop(): Promise<void>;
    start(request: ManagedHerdrStartRequest): Promise<ManagedHerdrResult>;
    private assertStable;
    private nativeTranscript;
    private awaitAcknowledgement;
}
