import type { ManagedAgentProvider } from "./agent-runtime.js";
/**
 * A provider condition that stops every agent on a host, not one turn. Each
 * kind names what was measured and the one act that clears it, so a host
 * reports the cause instead of a launch or a reply that silently never came.
 */
export type BlockingCondition =
/**
 * Measured on servyboi 2026-09-17: all 16 agents died on their first call
 * with an assistant record `error: "authentication_failed"`, text
 * "Login expired · Please run /login". Cleared by `startClaudeLogin`.
 */
{
    kind: "login-expired";
    provider: ManagedAgentProvider;
    detail: string;
}
/**
 * Measured 2026-09-18: after the CLI upgraded under a running daemon, every
 * background session settled "(crashed): daemon binary was deleted
 * (upgrade in progress)". `claude daemon stop --any --keep-workers` did NOT
 * preserve sessions through the next takeover (adopt reported dead=7), so
 * Drovr reports this and never stops the daemon on a caller's behalf.
 */
 | {
    kind: "daemon-binary-replaced";
    provider: "claude";
    detail: string;
    daemonPid?: number;
    daemonVersion?: string;
}
/**
 * Measured 2026-09-18, claude 2.1.276: a background session in a directory
 * whose `.mcp.json` names an unapproved server sits `state: "blocked"` on
 * "New MCP server found in this project". A workspace `settings.local.json`
 * approval is ignored while the directory is untrusted; launching with
 * `mcpServersApproved` (Claude's `--settings`) clears it.
 */
 | {
    kind: "mcp-approval-prompt";
    provider: "claude";
    detail: string;
};
export type BlockingConditionKind = BlockingCondition["kind"];
/** Terminal escapes: CSI (colour, cursor) and OSC (hyperlinks, titles). */
export declare function stripTerminalEscapes(text: string): string;
/**
 * Recognise a host-wide blocking condition in any provider text Drovr reads
 * back: launch output, a daemon log line, `claude logs`, a pane. Undefined
 * for anything else, including an ordinary failure, which stays the caller's.
 */
export declare function classifyBlockingText(provider: ManagedAgentProvider, raw: string): BlockingCondition | undefined;
/**
 * Recognise a blocking condition in one Claude transcript record. Claude tags
 * an API failure structurally (`isApiErrorMessage`, `error`), so this reads
 * the tag rather than the prose; a tool result that merely quotes the prose is
 * a user record and never matches.
 */
export declare function classifyClaudeTranscriptRecord(record: unknown): BlockingCondition | undefined;
/** Everything a daemon probe needs from the host; injectable for tests. */
export interface ClaudeDaemonProbeDeps {
    /** Runs `claude <args>` with plain output and resolves its result. */
    runClaude(args: readonly string[]): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    /** `readlink /proc/<pid>/exe`; resolves undefined where that is unreadable. */
    readExecutable(pid: number): Promise<string | undefined>;
}
export type ClaudeDaemonState = {
    running: false;
} | {
    running: true;
    pid: number;
    version?: string;
    executable?: string;
    binaryReplaced: boolean;
};
/**
 * Read the shared Claude daemon's pid and version from `claude daemon status`
 * and check whether the executable it is running still exists. Linux reports a
 * replaced executable as `<path> (deleted)`, which is exactly the state that
 * crashes every background spawn it serves.
 */
export declare function probeClaudeDaemon(deps?: Partial<ClaudeDaemonProbeDeps>): Promise<ClaudeDaemonState>;
/** The daemon as a blocking condition, or undefined when it is absent or sound. */
export declare function daemonBlockingCondition(state: ClaudeDaemonState): BlockingCondition | undefined;
/**
 * `claude auth status` reports only what is stored locally: a token the server
 * has since expired still reads `loggedIn: true`. It proves a logged-out host,
 * never a working one; an expired login is only proven by a refused call
 * (`classifyClaudeTranscriptRecord`).
 */
export declare function claudeLoggedIn(run?: ClaudeDaemonProbeDeps["runClaude"]): Promise<boolean>;
/**
 * The caller's environment minus FORCE_COLOR. Claude Code sets FORCE_COLOR in
 * every session, and `claude` then colours even piped output, so anything a
 * process inside a session runs and parses came back wrapped in escapes.
 * NO_COLOR is not set: a launched session inherits it and would lose colour in
 * its own terminal.
 */
export declare function plainOutputEnv(env?: Record<string, string | undefined>): Record<string, string>;
/** Runs `claude <args>` with plain output, stdin closed, both streams drained. */
export declare function runPlainClaude(args: readonly string[], cwd?: string): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
