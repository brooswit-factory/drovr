import { type InstanceFreezeStore } from './instance-freeze.js';
import type { ManagedConversationResult } from "./managed-conversation.js";
export interface CodexAppServerOptions {
    cwd: string;
    /** Stable host-namespaced identity; enables persistent operator freeze. */
    instanceId?: string;
    freezeStore?: InstanceFreezeStore;
    permissionMode?: string;
    model?: string;
    /** Overrides are scoped to this server; account configuration remains inherited. */
    config?: Readonly<Record<string, unknown>>;
    command?: readonly string[];
    env?: NodeJS.ProcessEnv;
    requestTimeoutMs?: number;
    onNotification?: (method: string, params: unknown) => void;
}
export interface AcceptedCodexTurn {
    conversationId: string;
    completed: Promise<ManagedConversationResult>;
}
/** One owned App Server and one loaded conversation, kept alive between messages. */
export declare class CodexAppServerRunner {
    private readonly options;
    private freezeWatch;
    private child;
    private readonly pending;
    private nextId;
    private initialized;
    private threadId;
    private active;
    private busy;
    private closed;
    private closing;
    private failure;
    constructor(options: CodexAppServerOptions);
    private fail;
    private initialize;
    private write;
    private request;
    private receive;
    message(text: string, conversationId?: string): Promise<ManagedConversationResult>;
    /** Acknowledge receipt separately from completion so subsequent events can steer. */
    acceptMessage(text: string, conversationId?: string): Promise<AcceptedCodexTurn>;
    /** False means no input accepted (idle/startup race or explicit server refusal). */
    steer(text: string): Promise<boolean>;
    /** Explicit host cancellation; never infer authority from channel message text. */
    interrupt(): Promise<boolean>;
    close(): Promise<void>;
    private closeOnce;
}
