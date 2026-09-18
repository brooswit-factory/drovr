// Read-only: list every Claude pane waiting on a dialog on the default herdr
// server. Calls only agent.list and agent.read; never sends a key.
import { DrovrClient } from "../src/drovr-client.js";
import { listBlockingPrompts } from "../src/blocking-prompts.js";

const client = new DrovrClient({ timeoutMs: 20_000 });
const found = await listBlockingPrompts(client);
const panes = (await client.agent.list()).agents.filter((agent) => agent.agent === "claude").length;
console.log(JSON.stringify({ claudePanes: panes, blocking: found.map(({ paneId, label, herdrStatus, kind, name }) => ({ paneId, label, herdrStatus, kind, name })) }));
process.exit(0);
