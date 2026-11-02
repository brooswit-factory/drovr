export interface NativeTranscriptOptions {
    provider: "claude" | "codex" | "agy";
    session: {
        kind: "id" | "path";
        value: string;
    };
    cwd: string;
    /** Whole-file cap in bytes; default 4 MiB, explicit maximum 64 MiB. */
    maxBytes?: number;
    home?: string;
    /** Explicit Codex profile. Otherwise explicit home wins over ambient CODEX_HOME. */
    codexHome?: string;
    /** Exact source session_meta.cwd for a migrated Codex identity. The caller must
     * bind this to the specific provider/session ID in trusted migration state.
     * It is metadata, never a filesystem lookup path; cwd remains the runtime cwd. */
    expectedSessionCwd?: string;
}
export declare class NativeTranscriptUnavailableError extends Error {
    constructor();
}
/** Extract model output only: a user prompt containing an ACK token is not an ACK. */
export declare function nativeTranscriptReply(provider: NativeTranscriptOptions["provider"], text: string): string | undefined;
export interface ClaudeTranscriptTail {
    /** Byte offset just past the last complete record returned; pass it back to continue. */
    offset: number;
    /** Complete JSONL records from the requested offset; a partial final record is left for the next read. */
    text: string;
}
/**
 * Incremental read of a live Claude transcript, which may exceed the
 * whole-file limit. `cwd` is where to look first; a session that has since
 * moved is found by its session ID wherever its transcript now lives.
 */
export declare function readClaudeTranscriptTail(options: {
    sessionId: string;
    cwd: string;
    home?: string;
}, offset: number): Promise<ClaudeTranscriptTail>;
/** Read native text unchanged; compaction and handoff remain separate operations. */
export declare function readNativeTranscript(options: NativeTranscriptOptions): Promise<string>;
