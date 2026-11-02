import { type ManagedAgentProvider, type ProviderLaunchInputs } from "./agent-runtime.js";
import { type BlockingCondition, type ClaudeDaemonState } from "./blocking-conditions.js";
import { type ClaudeBackgroundListing } from "./resident-agent.js";
/**
 * One background session to start, in the caller's vocabulary. Drovr spells
 * the provider's flags, their order, and the approvals a background session
 * cannot ask a human for.
 */
export interface BackgroundLaunchRequest extends ProviderLaunchInputs {
    provider: ManagedAgentProvider;
    /** Absolute directory the session runs in; it must already exist. */
    cwd: string;
    /** The session's first message. Omitted, the session starts idle. */
    prompt?: string;
    model?: string;
}
export type BackgroundLaunchRefusal =
/** Only Claude has a detached background session to start. */
"unsupported-provider"
/** A host-wide condition stops this launch; `blocking` says which and what clears it. */
 | "blocked"
/** The provider refused or printed nothing Drovr can read as a launch. */
 | "failed"
/** The provider printed an id no listing ever showed. */
 | "unlisted";
export type BackgroundLaunchResult = {
    ok: true;
    provider: "claude";
    /** What `claude attach|logs|stop|rm|respawn` take. */
    shortId: string;
    /** The full native session id, from the listing, never derived from the short id. */
    sessionId: string;
    cwd: string;
    /** The listing's own state at confirmation, carried through opaque. */
    state?: string;
} | {
    ok: false;
    reason: BackgroundLaunchRefusal;
    detail: string;
    blocking?: BlockingCondition;
    /** Present when a session did start, so the caller can stop or remove it. */
    shortId?: string;
    sessionId?: string;
};
export interface BackgroundLaunchDeps {
    /**
     * Runs the launch command in `cwd`. A host that wraps launches (a systemd
     * scope, a different user) wraps them here; Drovr only reads what it prints.
     */
    run(argv: readonly string[], cwd: string): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    listBackground(): Promise<ClaudeBackgroundListing[]>;
    /** `claude logs <shortId>`: the session's own screen, read for a blocking prompt. */
    readSessionScreen(shortId: string): Promise<string>;
    probeDaemon(): Promise<ClaudeDaemonState>;
    sleep(ms: number): Promise<void>;
    now(): number;
    /** How long a printed id may take to appear in the listing. */
    listTimeoutMs: number;
    /** How long after listing a session is watched for a blocking prompt. */
    settleMs: number;
    pollMs: number;
}
/**
 * The argv for one Claude background launch. Every option goes BEFORE `--bg`:
 * measured on claude 2.1.275, `--bg` does not parse what follows it but takes
 * it as the session's prompt, so a flag placed after it is silently demoted to
 * prompt text (Bakr's sessions named "server:yappr", with no subscription).
 */
export declare function buildBackgroundLaunchArgv(request: BackgroundLaunchRequest): string[];
/**
 * The short id `claude --bg` printed, measured on claude 2.1.276 as
 * `backgrounded · <id>` on stdout. Colour is stripped first: under FORCE_COLOR,
 * which Claude Code sets in every session, the id arrives as
 * `\x1b[36m582c43dc\x1b[39m` and an unstripped read records escapes as the id.
 */
export declare function parseBackgroundLaunchId(stdout: string): string | undefined;
/**
 * Start one background session and return its identity, proven against the
 * provider's own listing. A host deletes its own launch parsing and calls this.
 * It never retries, never stops the shared daemon, and never guesses an id
 * from a directory: a result is either a listed session or a stated refusal.
 */
export declare function launchBackgroundSession(request: BackgroundLaunchRequest, overrides?: Partial<BackgroundLaunchDeps>): Promise<BackgroundLaunchResult>;
