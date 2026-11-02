import type { ManagedAgentProvider } from "./agent-runtime.js";
/**
 * One declaration of intent — "this agent may use yappr" — rendered into each
 * vendor's own dialect here, so a caller states it once and never learns that
 * Claude spells it `enabledMcpjsonServers` in a workspace file, AGY spells it
 * `permissions.allow: ["mcp(yappr/*)"]` in a home file, and Codex spells it on
 * the command line. This is the same shape the runner already uses for
 * permission modes; MCP access was the part still left to every caller.
 *
 * Each vendor reads all of this at PROCESS START. A write to a running agent
 * changes nothing, and a Claude session already blocked on an unanswerable
 * approval prompt can never be rescued by a later write — which is why
 * `mcpAccessProvisioning` reports `restartRequired` rather than pretending a
 * write took effect, and why a provider switch must provision the TARGET
 * vendor before its first process starts.
 */
export interface McpServerAccess {
    /** The server's name as its own MCP configuration file names it. */
    name: string;
    /** Tools the agent may call; omitted means every tool the server offers. */
    tools?: readonly string[];
    /** Whether the agent should receive this server's notifications. */
    notifications?: boolean;
    /**
     * How to reach the server, for vendors that keep server definitions in a
     * file of their own (AGY). Omitted, only access is provisioned and the
     * vendor's existing definition is left as it is.
     */
    definition?: McpServerDefinition;
}
/** A server definition as `.mcp.json` states it, in no vendor's dialect. */
export type McpServerDefinition = {
    type: "http";
    url: string;
    headers?: Readonly<Record<string, string>>;
} | {
    type: "stdio";
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
};
/**
 * The servers a `.mcp.json` defines, in the neutral shape above. An entry with
 * a `url` is http (it may say `"type": "http"` or nothing); one with a
 * `command` is stdio. Anything else is refused rather than guessed at,
 * including `"type": "sse"`: agy 1.2.6 offers only stdio and http, and
 * serving an SSE server to it as streamable http would fail at connect time
 * instead of here (found by bakr in review).
 */
export declare function mcpServersFromMcpJson(json: unknown): Record<string, McpServerDefinition>;
/**
 * One server in AGY's own `mcp_config.json` dialect. Measured with
 * `agy mcp add` on agy 1.2.6 (2026-09-18): an http server is
 * `{serverUrl, headers, disabled}`, not `url`; a stdio server is
 * `{command, args, env, disabled}`.
 */
export declare function agyMcpServerEntry(definition: McpServerDefinition): Record<string, unknown>;
export interface McpAccessDeclaration {
    servers: readonly McpServerAccess[];
    /** Workspace whose per-project vendor settings this declaration governs. */
    cwd: string;
    /** The agent's own home, for vendors that keep permissions there. Defaults to this user's. */
    home?: string;
    /** How the agent's process runs; decides whether notifications can reach it at all. */
    runtime?: McpRuntime;
}
/**
 * What the agent that is running right now was actually started with.
 *
 * `notificationServers` left undefined means "not known", which is a third
 * answer, not a quiet zero. Treating unknown as unsubscribed would demand a
 * fresh launch on every call and never converge; treating it as subscribed
 * would reproduce exactly the bug this exists to catch. So unknown is reported
 * as unverified and the caller is told it cannot claim a subscription.
 */
export interface RunningMcpAccess {
    /** Servers whose channels its CURRENT process was launched with, if any. */
    notificationServers?: readonly string[];
}
/** One vendor settings file, and the exact keys this declaration governs in it. */
export interface McpSettingsEdit {
    path: string;
    /** Applied to the file's parsed contents; every other key is preserved. */
    apply: (settings: Record<string, unknown>) => Record<string, unknown>;
    /** Human-readable statement of what this edit asserts, for reporting. */
    describes: string;
}
export interface McpAccessProvisioning {
    /** Settings a vendor reads at process start, which must exist before it starts. */
    edits: readonly McpSettingsEdit[];
    /** MCP servers whose notifications the process must be started with. */
    notificationServers: readonly string[];
    /** Whether a subscription can reach this agent at all; see notificationSupport. */
    notifications: NotificationSupport;
}
/**
 * What it takes for a change to actually reach the agent.
 *
 * `restart` is enough for enablement, which every vendor re-reads at process
 * start. A subscription needs more: it is a launch-time argument, and a
 * respawn carries no arguments ever, so only a fresh launch or a fork can
 * apply one. Reporting that difference is the whole point — a caller that
 * respawns to pick up a subscription gets a session that looks restarted and
 * is still not subscribed.
 */
export type McpRestartKind = "none" | "restart" | "fresh-launch";
/**
 * How the agent's process runs. Only a Claude Code session with a terminal can
 * render a channel notification frame; `--print` has no acceptor for one and
 * skips channels entirely.
 */
export type McpRuntime = "interactive" | "print";
export type NotificationSupport = {
    supported: true;
    /** Conditions that must ALL hold; none of them is checkable after start. */
    requires: readonly string[];
    /** What remains unguaranteed even when they do hold. */
    caveat: string;
} | {
    supported: false;
    reason: string;
};
/**
 * Whether a notification subscription can reach this agent at all.
 *
 * Rendering a channel frame requires Claude Code specifically, launched with a
 * terminal and its channels, and a human accepting a permission prompt per
 * frame. That is the ceiling. AGY and Codex are the wrong runtime and can
 * never be woken this way, and headless Claude has no acceptor — so Drovr says
 * so here instead of emitting a flag that does nothing and letting a caller
 * believe a subscription exists.
 */
export declare function notificationSupport(provider: ManagedAgentProvider, runtime?: McpRuntime): NotificationSupport;
/**
 * What one vendor needs on disk, and at process start, for this declaration to
 * hold. Pure: it decides and describes, and writes nothing.
 */
export declare function mcpAccessProvisioning(provider: ManagedAgentProvider, declaration: McpAccessDeclaration): McpAccessProvisioning;
export interface McpSettingsIo {
    /** Resolves undefined when the file is absent; anything else is an error. */
    readSettings: (path: string) => Promise<string | undefined>;
    writeSettings: (path: string, contents: string) => Promise<void>;
}
/** Reads and writes a vendor settings file as the agent's own user, refusing symlinks. */
export declare const realMcpSettingsIo: McpSettingsIo;
export interface McpAccessApplied {
    /** True when a file changed, which is exactly when a running agent is stale. */
    changed: boolean;
    /**
     * A running agent read its MCP configuration at start, so a change here does
     * not reach it. It is restarted, never merely written to.
     */
    restartRequired: boolean;
    /** How the running agent must come back for this to reach it. */
    restart: McpRestartKind;
    /** Files actually rewritten, for reporting. */
    written: readonly string[];
    notificationServers: readonly string[];
    /** Subscriptions asked for that this provider and runtime cannot deliver. */
    notifications: NotificationSupport;
    /**
     * True when a subscription was asked for and could be delivered, but the
     * caller did not say what the running process was launched with. Nothing can
     * claim this agent is subscribed until a launch is observed.
     */
    subscriptionUnverified: boolean;
}
/**
 * Bring one vendor's settings into line with the declaration, preserving every
 * key this declaration does not govern. Idempotent: a settings file that
 * already grants the access is left untouched and reports `changed: false`, so
 * a caller never restarts an agent that did not need it.
 */
export declare function applyMcpAccess(provider: ManagedAgentProvider, declaration: McpAccessDeclaration, io?: McpSettingsIo, running?: RunningMcpAccess): Promise<McpAccessApplied>;
export interface IdentityReleaseOptions {
    /** True once the previous holder is confirmed gone. Asked repeatedly. */
    released: () => Promise<boolean>;
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
export declare class IdentityStillHeldError extends Error {
    readonly elapsedMs: number;
    readonly code = "identity_still_held";
    constructor(elapsedMs: number);
}
/**
 * Wait until the previous holder of a single-holder identity is CONFIRMED
 * gone. Measured: a notification service allows one connection per identity,
 * and when a bridge child died its registration was not reaped — every new
 * bridge was refused, the model saw zero tools, and the symptom looked exactly
 * like broken MCP configuration. Only a full service restart cleared it, at
 * the cost of every other identity's registration.
 *
 * So this asks a real question and fails loudly on a deadline. It is
 * deliberately not a sleep: a sleep long enough to usually work is also a
 * sleep that silently declares readiness when the holder is still there.
 */
export declare function awaitIdentityRelease(options: IdentityReleaseOptions): Promise<void>;
export interface McpRestartDeps<T> extends Partial<IdentityReleaseOptions> {
    /** Stops the agent currently holding the identity. */
    stop: () => Promise<void>;
    /**
     * Starts the agent again, only after the identity is confirmed free. It is
     * told which kind of start this has to be: `fresh-launch` means a respawn
     * cannot satisfy it, because the change is a launch-time argument.
     */
    start: (kind: Exclude<McpRestartKind, "none">) => Promise<T>;
    /** Confirms the previous holder is gone; required, because a sleep cannot. */
    released: () => Promise<boolean>;
    io?: McpSettingsIo;
}
export interface McpAccessChange<T> {
    applied: McpAccessApplied;
    /** Absent when nothing changed and the running agent was therefore left alone. */
    restarted?: T;
}
/**
 * Set the CURRENT agent's MCP access and restart it, in that order, behind a
 * verified identity release.
 *
 * The ordering is the whole point. Provisioning happens BEFORE the new process
 * starts, because every vendor reads it at start. The restart happens because a
 * write alone reaches no running process. And the start waits on a real check
 * that the previous holder released the identity, because a single-holder
 * identity that was never reaped makes the new agent come up toolless while
 * reporting success.
 */
export declare function setMcpAccess<T>(provider: ManagedAgentProvider, declaration: McpAccessDeclaration, deps: McpRestartDeps<T>, running?: RunningMcpAccess): Promise<McpAccessChange<T>>;
/**
 * Provision the TARGET vendor's MCP access before its first process starts,
 * then start it — the same ordering the conversation lifecycle already keeps
 * for native identity and history import. Out of order, the first turn on the
 * new provider comes up with no tools and, on AGY, silently succeeds with
 * empty output.
 */
export declare function switchProviderMcpAccess<T>(target: ManagedAgentProvider, declaration: McpAccessDeclaration, deps: {
    start: (kind: Exclude<McpRestartKind, "none">) => Promise<T>;
    io?: McpSettingsIo;
} & Partial<Pick<McpRestartDeps<T>, "released" | "timeoutMs" | "pollMs" | "now" | "sleep">>): Promise<McpAccessChange<T>>;
