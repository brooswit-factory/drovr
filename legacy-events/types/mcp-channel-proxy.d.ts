import { type KeepChannelSourceOptions } from "./inbox-relay.js";
/** One upstream identity serves channel events and the resident's normal MCP requests. */
export declare function startMcpChannelProxy(options: Omit<KeepChannelSourceOptions, "onClient">): Promise<{
    ready: Promise<void>;
    url: string;
    headers: {
        Authorization: string;
    };
    close(): Promise<void>;
}>;
