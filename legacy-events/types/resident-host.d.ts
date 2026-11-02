import type { results } from "@brooswit/herdr-sdk";
import { type ManagedAgentProvider, type ProviderLaunchInputs } from "./agent-runtime.js";
import { type AgentStartOptions } from "./agent-start.js";
import type { DrovrClient } from "./drovr-client.js";
/**
 * Hosting a resident: a long-lived interactive provider session in its own
 * herdr workspace pane, reachable by channel frames and by `--resume` later.
 *
 * Why a pane and not `claude --bg`: measured on claude 2.1.276, a background
 * session never shows the "Loading development channels" confirmation and
 * never delivers a channel frame as a turn, while the same session resumed in
 * a terminal pane, the confirmation answered, receives yappr and rocketr
 * frames as live turns (rocketr agent, session 517fd13a, 2026-09-18).
 *
 * Why every pane carries its label as its herdr agent name: herdr refuses a
 * second agent under a name already in use. On 2026-09-18 bakr started every
 * pane as `claude`, so once one pane held the name every later start failed
 * after its old session had already been stopped (seven agents down). A host
 * therefore checks the name is free before it creates anything.
 */
type AgentInfo = results.AgentInfo;
type HostClient = {
    agent: Pick<DrovrClient["agent"], "list" | "get" | "read" | "sendKeys" | "start" | "prompt">;
    pane: Pick<DrovrClient["pane"], "processInfo" | "read">;
    workspace: Pick<DrovrClient["workspace"], "create" | "close" | "list">;
};
/** Every workspace Drovr hosts carries this label prefix, so a listing can tell Drovr's panes from anyone else's. */
export declare const RESIDENT_WORKSPACE_PREFIX = "drovr ";
export interface HostResidentRequest {
    provider: ManagedAgentProvider;
    cwd: string;
    /** Unique on this host: the resident's herdr agent name. */
    label: string;
    /** Provider-neutral MCP and channel configuration; Drovr spells the flags. */
    inputs?: ProviderLaunchInputs;
    /** Native session id to resume. Omitted, Drovr names a fresh session itself. */
    resume?: string;
    /**
     * First user turn, submitted once the input box is ready. Not passed as an
     * argv prompt: measured 2026-09-18, a positional prompt given alongside the
     * trust and development-channels confirmations never became a turn.
     */
    prompt?: string;
    model?: string;
    env?: Record<string, string>;
}
export type HostResidentRefusalReason =
/** Only Claude is hosted so far; other providers keep their managed lifecycles. */
"unsupported-provider" | "invalid-label"
/** Another pane already holds this herdr agent name; nothing was created. */
 | "label-taken" | "workspace-failed" | "start-failed"
/** A startup prompt Drovr does not answer; the workspace was closed. */
 | "blocked-prompt"
/** `resume` named a session with no transcript here; the workspace was closed. */
 | "no-such-session"
/** `resume` named a session whose conversation belongs to another directory. */
 | "wrong-directory" | "not-ready";
export type HostResidentResult =
/** `promptError` is set when the resident is up but herdr refused its first turn. */
{
    ok: true;
    paneId: string;
    workspaceId: string;
    sessionId: string;
    promptError?: string;
} | {
    ok: false;
    reason: HostResidentRefusalReason;
    detail: string;
    paneId?: string;
    excerpt?: string;
};
export interface ResidentHostOptions {
    readyTimeoutMs?: number;
    pollIntervalMs?: number;
    /** Clean, ready reads in a row that count as ready when herdr never names the session. Default 3. */
    cleanReadsWithoutSession?: number;
    /** Passed to herdr's agent.start; herdr requires 3000 < value <= 300000. */
    startTimeoutMs?: number;
    /** Bounds the wait for a new pane's shell; defaults to 10s. */
    startOptions?: AgentStartOptions;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    mintSessionId?: () => string;
}
/**
 * The keys that move a menu's cursor onto the option matching `wanted` and
 * confirm it. Reads the cursor from the screen rather than assuming an order,
 * so a provider reordering its options cannot turn "trust" into "exit".
 */
export declare function keysToChoose(screen: string, wanted: RegExp): string[] | undefined;
export type StartupPrompt = {
    kind: "trust";
    keys: string[];
} | {
    kind: "development-channels";
    keys: string[];
} | {
    kind: "auto-mode-onboarding";
    keys: string[];
} | {
    kind: "mcp-approval";
    excerpt: string;
} | {
    kind: "unknown-blocking";
    excerpt: string;
};
/**
 * Which startup prompt a Claude pane shows, and the keys that answer it. Only
 * prompts a hosted resident must accept are answered: folder trust (the
 * caller chose this directory) and the development-channels warning (the
 * caller asked for those channels). An MCP approval prompt is reported, not
 * answered: approval travels on the launch (`mcpServersApproved`).
 */
export declare function classifyStartupPrompt(raw: string): StartupPrompt | undefined;
/** The provider argv a hosted Claude resident starts with. */
export declare function buildResidentClaudeArgs(request: HostResidentRequest, sessionId: string): string[];
/**
 * Start a resident in a new herdr workspace rooted at `cwd`, answer the
 * startup prompts it cannot, and return its pane once its input box is ready.
 * A resident that cannot get there has its workspace closed, so no
 * half-started pane is left holding an MCP identity or its agent name.
 */
export declare function hostResident(client: HostClient, request: HostResidentRequest, options?: ResidentHostOptions): Promise<HostResidentResult>;
export interface ResidentListing {
    paneId: string;
    workspaceId: string;
    label: string;
    provider: string | undefined;
    sessionId: string | undefined;
    cwd: string | undefined;
    status: AgentInfo["agent_status"];
    /** The provider process's pid, for a host's own liveness check; undefined when herdr cannot say. */
    pid: number | undefined;
}
/** Every resident Drovr hosts: agent panes in a workspace carrying Drovr's label prefix. */
export declare function listResidents(client: Pick<HostClient, "agent" | "workspace" | "pane">): Promise<ResidentListing[]>;
export type StopResidentResult = {
    ok: true;
    workspaceId: string;
} | {
    ok: false;
    reason: "not-found" | "not-hosted" | "close-failed";
    detail: string;
};
/**
 * Close a hosted resident's whole workspace: the provider process ends and
 * its transcript stays for a later `resume`. Refuses a pane Drovr did not
 * host, so a stale id can never close someone else's workspace.
 */
export declare function stopResident(client: Pick<HostClient, "agent" | "workspace" | "pane">, paneId: string): Promise<StopResidentResult>;
export {};
