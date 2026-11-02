import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { keepChannelSource, type KeepChannelSourceOptions } from "./inbox-relay.js";

/** One upstream identity serves channel events and the resident's normal MCP requests. */
export async function startMcpChannelProxy(options: Omit<KeepChannelSourceOptions, "onClient">) {
  let upstream: Client | undefined;
  const downstream = new Set<Server>();
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const secret = randomUUID();
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const keeper = keepChannelSource({ ...options, onClient: client => { upstream = client; if (client) resolveReady(); } });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      if (request.headers.has("origin") || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Forbidden", { status: 403 });
      if (!upstream) return new Response("MCP upstream disconnected", { status: 503 });
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const transport = transports.get(sessionId);
        return transport ? transport.handleRequest(request) : new Response("Unknown session", { status: 404 });
      }
      if (request.method !== "POST") return new Response("Initialize required", { status: 400 });
      const rpc = new Server(upstream.getServerVersion() ?? { name: options.name, version: "1" }, { capabilities: upstream.getServerCapabilities() ?? {} });
      rpc.fallbackRequestHandler = async (message, extra) => {
        if (!upstream) throw new Error("MCP upstream disconnected");
        return upstream.request({ method: message.method, params: message.params }, ResultSchema, { signal: extra.signal });
      };
      rpc.fallbackNotificationHandler = async notification => { await upstream?.notification(notification); };
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: id => { transports.set(id, transport); },
      });
      transport.onclose = () => { downstream.delete(rpc); if (transport.sessionId) transports.delete(transport.sessionId); };
      downstream.add(rpc);
      try {
        await rpc.connect(transport);
        const response = await transport.handleRequest(request);
        // Invalid initialization requests must not retain an unused server.
        if (!transport.sessionId) await rpc.close();
        return response;
      } catch (error) {
        await rpc.close().catch(() => {});
        throw error;
      }
    },
  });
  return {
    ready,
    url: `http://127.0.0.1:${server.port}/mcp`,
    headers: { Authorization: `Bearer ${secret}` },
    async close() {
      await keeper.stop();
      await Promise.all([...downstream].map(client => client.close()));
      await server.stop(true);
    },
  };
}
