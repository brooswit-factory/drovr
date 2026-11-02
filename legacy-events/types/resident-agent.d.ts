import type { ManagedAgentProvider } from "./agent-runtime.js";
import { type ClaudeTranscriptTail } from "./native-transcript.js";
/** A long-lived agent session that is already running; the host never names provider mechanics. */
export interface ResidentAgentTarget {
    provider: ManagedAgentProvider;
    /** Native conversation/session ID of the running resident. */
    sessionId: string;
    cwd: string;
}
export interface ResidentMessageOptions {
    /** How long to wait for the resident to finish its turn after delivery is confirmed. */
    replyTimeoutMs?: number;
}
export type ResidentMessageResult =
/** Delivered to the same running session and its turn finished. */
{
    status: "replied";
    reply: string;
}
/** Delivered to the same running session; the turn had not finished before the timeout. */
 | {
    status: "reply-pending";
    reply: string;
};
export type ResidentMessageRefusalReason = "unsupported-provider" | "invalid-message" | "not-running" | "busy" | "blocked" | "delivery-unconfirmed";
/** Nothing here ever falls back to a new, resumed, or forked session. */
export declare class ResidentMessageRefusal extends Error {
    readonly reason: ResidentMessageRefusalReason;
    constructor(reason: ResidentMessageRefusalReason, message: string);
}
export interface ResidentAgentMessenger {
    message(target: ResidentAgentTarget, text: string, options?: ResidentMessageOptions): Promise<ResidentMessageResult>;
}
export interface ClaudeBackgroundListing {
    id: string;
    sessionId: string;
    cwd: string;
    status?: string;
}
export interface ResidentTerminal {
    write(data: string): void;
    /** Milliseconds since epoch of the latest terminal output, or undefined before any. */
    lastOutputAt(): number | undefined;
    /** Resolves when the attach client exits on its own. */
    exited: Promise<number>;
    /** Detach only: stops the attach client, never the resident session. */
    close(): Promise<void>;
}
export interface ClaudeResidentDeps {
    listBackground(): Promise<ClaudeBackgroundListing[]>;
    openAttach(shortId: string, cwd: string): ResidentTerminal;
    /** The session's current screen (`claude logs`), read only when its listing reports no status. */
    readScreen(shortId: string): Promise<string>;
    readTail(target: ResidentAgentTarget, offset: number): Promise<ClaudeTranscriptTail>;
    now(): number;
    sleep(ms: number): Promise<void>;
    attachReadyTimeoutMs: number;
    deliveryTimeoutMs: number;
    pollMs: number;
}
export declare const RESIDENT_MESSAGE_MAX_CHARS = 16000;
export declare function listClaudeBackgroundSessions(): Promise<ClaudeBackgroundListing[]>;
export declare function openClaudeAttach(shortId: string, cwd: string): ResidentTerminal;
/**
 * What a listed Claude session is doing, read from its listing and transcript:
 * - `idle`: listed idle, or listed with no status (never prompted; the caller
 *   checks its screen for a blocking prompt).
 * - `background`: listed busy only because background workers (a Monitor, a
 *   background shell) keep running while the session waits at its prompt.
 * - `turn`: mid-turn; typed input would queue behind unknown work.
 *
 * Measured 2026-09-18: `claude agents --json` lists a session `busy` for as
 * long as any Monitor runs. lead-dynamic-atmosphere listed busy/working while
 * its last conversation record was the `turn_duration` that closed its turn
 * sixteen minutes earlier. herdr's screen detection already calls such a pane
 * `done`; this is the same judgement for the listing. A turn is ended only
 * when the last main-thread conversation record is `turn_duration`, so a turn
 * cut off without one reads as `turn`, the safe side.
 */
export type ClaudeResidentActivity = "idle" | "background" | "turn" | "blocked";
/**
 * Only Claude's own `busy` can become `background`. A session stopped on a
 * dialog (listed `blocked`, e.g. a resume held at folder trust) also has a
 * transcript that ends on its previous turn's close, and typing into it could
 * answer the dialog (found by bakr in review). Any status not named here is
 * read as mid-turn: an unknown state is never sendable.
 */
export declare function claudeResidentActivity(status: string | undefined, transcript: string): ClaudeResidentActivity;
/**
 * Claude Code has no machine API for a running background session: `claude -p --resume <id>`
 * refuses while it runs and `--fork-session` is a different session. Its documented
 * `claude attach` terminal is the only path to the same process, so delivery is typed there
 * and proven only by the session's own transcript. The reply is read from that transcript.
 */
export declare class ClaudeResidentMessenger implements ResidentAgentMessenger {
    private queue;
    private readonly deps;
    constructor(deps?: Partial<ClaudeResidentDeps>);
    message(target: ResidentAgentTarget, text: string, options?: ResidentMessageOptions): Promise<ResidentMessageResult>;
    private messageNow;
    /**
     * Reads the transcript where the session keeps it now. A missing transcript
     * is re-checked against the listing: if the exact same session is listed
     * under another cwd, it moved, and its transcript moved with it (Claude Code
     * carries the file, history intact, to the new directory's project folder),
     * so reading continues there from the same offset. Anything else — the
     * session gone, or no move — is the original failure, never a guess at
     * another session.
     */
    private readFollowing;
}
/** Provider-neutral entry point. Providers without a proven same-session transport refuse. */
export declare function createResidentAgentMessenger(claude?: Partial<ClaudeResidentDeps>): ResidentAgentMessenger;
