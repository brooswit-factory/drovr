import { Client } from "@modelcontextprotocol/sdk/client/index.js";
/**
 * Live inbound messages for an agent whose vendor cannot render a channel
 * frame (agy, codex): a relay holds the notification stream in the agent's
 * place and delivers each message as a turn through the host's own API.
 *
 * Why a relay: a channel push reaches only a connected MCP client that keeps
 * a notification stream open, and only Claude Code turns one into a turn.
 * usrr runs agy one `--print` turn at a time, so between turns nothing is
 * connected at all (read from usrr at 1aab596, 2026-09-18).
 */
/** One inbound message, as the channel carried it. `meta` holds only strings. */
export interface InboxMessage {
    /** The server it came from, e.g. "rocketr". */
    source: string;
    content: string;
    meta: Readonly<Record<string, string>>;
}
export type DeliveryOutcome =
/** The host recorded it as a turn for the agent. */
{
    status: "delivered";
}
/** The agent is mid-turn; try again later. Nothing was recorded. */
 | {
    status: "busy";
}
/** The host refused this message for good (e.g. too long); it is dropped, and reported. */
 | {
    status: "rejected";
    detail: string;
}
/** The receiver may have accepted it. Pause instead of duplicating a turn. */
 | {
    status: "uncertain";
    detail: string;
}
/** Anything else; the message is kept and retried, up to `maxAttempts`. */
 | {
    status: "failed";
    detail: string;
};
export type Deliver = (text: string, message: InboxMessage) => Promise<DeliveryOutcome>;
/**
 * The turn text an agent sees. The message is wrapped the way Claude Code
 * renders a channel frame, so a model that never saw a channel still reads it
 * as external data with its origin, not as its operator's words.
 *
 * Anyone who can post in a room controls `content`, so the frame must hold:
 * every `<channel` / `</channel` in the body is neutralised to `&lt;…`, so a
 * body containing `</channel>` cannot end the frame early and have the text
 * after it read as the operator's (found by bakr in review). The notice that
 * the frame is external data comes first, before anything the sender wrote.
 */
export declare function renderInboxTurn(message: InboxMessage): string;
export interface InboxRelayOptions {
    deliver: Deliver;
    /** Coalesce a burst and queued backlog into one input; 0 preserves individual delivery. */
    batchMs?: number;
    /** Wait before retrying a busy or failed delivery. Default 5s. */
    retryMs?: number;
    /** Oldest messages are dropped, and reported, past this many queued. Default 200. */
    maxQueue?: number;
    /**
     * Failed attempts before a message is dropped, and reported, so one message
     * the host keeps failing on cannot block everything behind it. Busy answers
     * never count: a long turn is not a failure. Default 20.
     */
    maxAttempts?: number;
    onEvent?: (event: InboxRelayEvent) => void;
    wait?: (ms: number) => Promise<void>;
}
export type InboxRelayEvent = {
    kind: "delivered";
    message: InboxMessage;
} | {
    kind: "retrying";
    message: InboxMessage;
    outcome: DeliveryOutcome;
} | {
    kind: "dropped";
    message: InboxMessage;
    reason: string;
};
/**
 * A queue that delivers messages one at a time, in arrival order. usrr has no
 * queue of its own and refuses a message during a turn (409), so ordering and
 * retry live here.
 *
 * Delivery semantics, stated plainly:
 * - A busy answer is retried for as long as it takes.
 * - A failure is retried up to `maxAttempts`, then that message is dropped.
 * - A rejection (the host refused this message for good) is dropped at once.
 * - Past `maxQueue`, the oldest queued message is dropped.
 * Every drop is reported as a `dropped` event.
 * - At least once, not exactly once: an attempt that times out after the host
 *   has already recorded it is retried, and becomes a duplicate turn.
 * - The queue lives in memory only. A sender's server reports delivery (thatch's
 *   C2) once the relay's stream has the frame, so a relay that dies with
 *   messages queued loses them.
 */
export declare class InboxRelay {
    private readonly options;
    private readonly queue;
    private inFlight;
    private draining;
    private stopped;
    private readonly retryMs;
    private readonly maxQueue;
    private readonly maxAttempts;
    private readonly wait;
    constructor(options: InboxRelayOptions);
    get pending(): number;
    push(message: InboxMessage): void;
    /** Resolves once everything queued so far is delivered, or the relay stopped. */
    idle(): Promise<void>;
    stop(): void;
    private drain;
}
/** The notification a thatch server (rocketr, yappr) pushes; Claude Code renders it as `<channel>`. */
export declare const CHANNEL_NOTIFICATION = "notifications/claude/channel";
/** A thatch frame: meta values are strings, or the frame is not a message. */
export declare function inboxMessageFromNotification(source: string, params: unknown): InboxMessage | undefined;
export interface ChannelSourceOptions {
    /** The server's name, used as the message's `source`. */
    name: string;
    url: string;
    /** Account headers, exactly as the agent's `.mcp.json` states them. */
    headers?: Readonly<Record<string, string>>;
    onMessage: (message: InboxMessage) => void;
    onClose?: () => void;
    /** Transport errors, e.g. the server forgot this session after a restart. */
    onError?: (error: Error) => void;
    /** Share this connection with a local MCP tool proxy rather than claiming the identity twice. */
    onClient?: (client: Client | undefined) => void;
}
/**
 * Connect to a thatch server as an MCP client and hand every channel frame to
 * `onMessage`. The client keeps the notification stream open, which is also
 * what keeps thatch from reaping the session as stale.
 */
export declare function connectChannelSource(options: ChannelSourceOptions): Promise<{
    close: () => Promise<void>;
}>;
export type ChannelSourceStatus = {
    kind: "connected";
} | {
    kind: "disconnected";
    reason: string;
} | {
    kind: "reconnecting";
    inMs: number;
};
export interface KeepChannelSourceOptions extends Omit<ChannelSourceOptions, "onClose" | "onError"> {
    onStatus?: (status: ChannelSourceStatus) => void;
    /** First wait before reconnecting; doubles per failed attempt up to `maxBackoffMs`. Default 1s. */
    backoffMs?: number;
    /** Default 30s. */
    maxBackoffMs?: number;
    /** Injection for tests; defaults to connectChannelSource. */
    connect?: (options: ChannelSourceOptions) => Promise<{
        close: () => Promise<void>;
    }>;
    wait?: (ms: number) => Promise<void>;
}
/**
 * Stay connected. A thatch server does not replay what it pushed while no
 * stream was attached, and after a server restart the old session is unknown
 * to it, so a relay that only reported the drop would go deaf for good (found
 * by bakr in review). This reconnects on close, on a transport error, and on a
 * failed connect, with capped exponential backoff, until `stop()`.
 */
export declare function keepChannelSource(options: KeepChannelSourceOptions): {
    stop: () => Promise<void>;
};
/**
 * Deliver through usrr's own API: `POST /v1/message {text, wait:false}` on its
 * unix socket. usrr answers `accepted` only after it has saved the message as a
 * user turn in its transcript, so that answer is the delivery proof; a 409 is
 * usrr mid-turn with no queue of its own.
 */
export declare function usrrDeliver(socketPath: string): Deliver;
