import type { ManagedAgentProvider } from "./agent-runtime.js";
import { type ConversationIdentity, type ConversationSessionOptions } from "./conversation-session.js";
import { type ManagedConversationResult } from "./managed-conversation.js";
import { readNativeTranscript } from "./native-transcript.js";
import { type ProviderAvailabilityRegistry } from "./provider-fallback.js";
export interface ManagedConversationMessageOptions {
    /** Exclusive journal cutoff: the pending user event is not imported history. */
    beforeSequence?: number;
    reason?: string;
}
export interface ManagedConversationCommitContext {
    kind: "message" | "handoff";
    previous?: ConversationIdentity;
    reason: string;
    beforeSequence?: number;
}
export interface ManagedConversationLifecycleOptions {
    current?: ConversationIdentity;
    cwd: string;
    providers: readonly ManagedAgentProvider[];
    accountId: string;
    availability?: ProviderAvailabilityRegistry;
    createRunner: ConversationSessionOptions["createRunner"];
    /** Explicit journal fallback, used only when native history is absent. */
    readTranscript?: (beforeSequence?: number) => Promise<string>;
    /** Native disk reader injection for hosts and deterministic boundary tests. */
    readNativeTranscript?: typeof readNativeTranscript;
    commit: (identity: ConversationIdentity, context: ManagedConversationCommitContext) => Promise<void>;
}
/** Owns native identity, selection and every transition for a managed conversation. */
export declare class ManagedConversationLifecycle {
    private readonly options;
    private active;
    private queue;
    private readonly providers;
    constructor(options: ManagedConversationLifecycleOptions);
    get current(): ConversationIdentity | undefined;
    private serialize;
    private validateProvider;
    private validateIdentity;
    private history;
    private commit;
    private switchNow;
    switchProvider(provider: ManagedAgentProvider, reason?: string): Promise<ConversationIdentity>;
    message(text: string, options?: ManagedConversationMessageOptions): Promise<ManagedConversationResult>;
}
