// Opt-in, listen-only proof of connectChannelSource against a live thatch server.
// Connects with the given MCP server entry from a .mcp.json, prints the first
// channel frame (source, meta keys, content length) and exits. Sends nothing.
import { readFileSync } from "node:fs";
import { connectChannelSource, renderInboxTurn } from "../src/inbox-relay.js";

const [mcpJsonPath, serverName = "rocketr", timeoutSec = "120"] = process.argv.slice(2);
if (!mcpJsonPath) throw new Error("usage: probe-channel-source.ts <.mcp.json> [server] [timeoutSec]");
const entry = JSON.parse(readFileSync(mcpJsonPath, "utf8")).mcpServers?.[serverName];
if (!entry?.url) throw new Error(`${serverName} is not an http server in ${mcpJsonPath}`);

const started = Date.now();
const timer = setTimeout(() => { console.log(JSON.stringify({ stage: "timeout", afterSec: Number(timeoutSec) })); process.exit(1); }, Number(timeoutSec) * 1000);
const source = await connectChannelSource({
  name: serverName,
  url: entry.url,
  headers: entry.headers ?? {},
  onMessage: async (message) => {
    clearTimeout(timer);
    const turn = renderInboxTurn(message);
    console.log(JSON.stringify({
      stage: "frame",
      afterMs: Date.now() - started,
      source: message.source,
      metaKeys: Object.keys(message.meta).sort(),
      contentChars: message.content.length,
      turnStartsWith: turn.slice(0, 40),
    }));
    await source.close();
    process.exit(0);
  },
  onClose: () => console.log(JSON.stringify({ stage: "closed" })),
});
console.log(JSON.stringify({ stage: "connected", url: entry.url }));
