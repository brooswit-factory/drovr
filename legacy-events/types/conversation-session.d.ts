import type { ManagedAgentProvider } from "./agent-runtime.js";
import type { ManagedConversationResult } from "./managed-conversation.js";
export interface ConversationIdentity {
    provider: ManagedAgentProvider;
    conversationId: string;
}
export interface ConversationSessionOptions {
    current?: ConversationIdentity;
    cwd: string;
    /** Read a consistent snapshot of saved history, not terminal-screen contents. */
    readTranscript: () => Promise<string>;
    createRunner: (provider: ManagedAgentProvider) => {
        message(text: string, id?: string): Promise<ManagedConversationResult>;
    };
    /** Atomically persist the new identity. The previous identity remains current on failure. */
    commit: (identity: ConversationIdentity) => Promise<void>;
}
export declare const HANDOFF_ACK = "DROVR_HANDOFF_READY";
export declare const HANDOFF_CHUNK_CHARS = 48000;
/** Provider-neutral handoff. No work is dispatched and no old session is destroyed here. */
export declare class ManagedConversationSession {
    private readonly options;
    private active;
    private queue;
    constructor(options: ConversationSessionOptions);
    get current(): ConversationIdentity | undefined;
    switchProvider(provider: ManagedAgentProvider, reason: string): Promise<ConversationIdentity>;
    private switchNow;
}
