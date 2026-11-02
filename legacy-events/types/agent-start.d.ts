import { type ParamsOf, type ResultOf } from "@brooswit/herdr-sdk";
import type { DrovrClient } from "./drovr-client.js";
export interface AgentStartOptions {
    /** Bounds retries after confirmed shell-busy rejections, not an in-flight launch. */
    readinessTimeoutMs?: number;
    retryIntervalMs?: number;
    /** Monotonic clock and wait injection for deterministic tests. */
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    /** Test seam for the bounded, read-only timeout diagnostic. */
    diagnosticWait?: (ms: number) => Promise<void>;
}
export interface ShellReadinessDiagnostics {
    attempts: number;
    elapsedMs: number;
    processInfo: "available" | "unavailable";
    shellPid?: number;
    foregroundProcessGroupId?: number;
    foregroundProcessCount?: number;
    otherForegroundProcessCount?: number;
}
export declare class AgentShellReadinessError extends Error {
    readonly diagnostics: ShellReadinessDiagnostics;
    readonly code = "agent_shell_readiness_timeout";
    constructor(diagnostics: ShellReadinessDiagnostics);
}
type StartClient = {
    agent: Pick<DrovrClient["agent"], "start">;
    pane: Pick<DrovrClient["pane"], "processInfo">;
};
/**
 * Herdr alone decides whether a pane is an available supported shell. Retry
 * only its explicit pre-launch busy refusal; uncertain failures must never
 * cause a second launch. The native agent.start timeout remains unchanged.
 * On exhaustion, a best-effort diagnostic read adds at most 250ms.
 * The caller retains ownership of pane cleanup and provider fallback.
 */
export declare function startManagedAgent(client: StartClient, params: ParamsOf<"agent.start">, options?: AgentStartOptions): Promise<ResultOf<"agent.start">>;
export {};
