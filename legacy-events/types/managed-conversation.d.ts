import type { ManagedAgentProvider } from "./agent-runtime.js";
import type { ProviderQuotaRefusal } from "./provider-fallback.js";
/** Confirmed native CLI quota refusal, never inferred from arbitrary failures. */
export declare class ManagedConversationQuotaError extends Error {
    readonly provider: "claude";
    readonly refusal: ProviderQuotaRefusal;
    constructor(refusal: ProviderQuotaRefusal);
}
export interface ManagedConversationResult {
    conversationId: string;
    response: string;
}
/**
 * AGY headless answers a turn whose tool calls were all denied with
 * `status: "SUCCESS"`, an EMPTY `response`, and the denials listed in
 * `denied_actions` — measured shape `{action: "mcp", display_name:
 * "CallMcpTool"}`. Parsed as a plain result, that is an assistant turn that
 * said nothing, and a host persists it as one; the actual cause (no
 * `permissions.allow` entry for the server) is invisible and every symptom
 * points at MCP configuration instead. Refusing it here turns that whole
 * class into one line of diagnosis.
 */
export declare class AgyDeniedActionsError extends Error {
    readonly provider: "agy";
    /** The vendor's own display names, in the order AGY reported them. */
    readonly deniedActions: readonly string[];
    constructor(deniedActions: readonly string[]);
}
export type RunProcess = (argv: readonly string[], cwd: string) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
/** Direct CLI transport; stdin is closed, both output streams are drained, and output is never coloured for parsing. */
export declare const runConversationProcess: RunProcess;
export interface ManagedConversationRunnerOptions {
    provider: ManagedAgentProvider;
    cwd: string;
    /** "yolo", "plan", or otherwise "accept-edits", matching USRR's AGY behavior. */
    permissionMode?: string;
    run?: RunProcess;
}
/** Single-provider transport; ManagedConversationLifecycle owns selection and identity, with durable storage through its commit callback. */
export declare class ManagedConversationRunner {
    readonly provider: ManagedAgentProvider;
    private readonly cwd;
    private readonly mode;
    private readonly run;
    constructor(options: ManagedConversationRunnerOptions);
    private permissionArgs;
    private messageArgv;
    message(text: string, conversationId?: string): Promise<ManagedConversationResult>;
    attachArgv(conversationId: string): string[];
}
