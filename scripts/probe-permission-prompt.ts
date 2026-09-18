// Opt-in probe: start claude in default permission mode in a named drovr-proof
// herdr session, ask for a Bash command, and print the permission dialog's screen.
import { DrovrClient } from "../src/drovr-client.js";
import { classifyStartupPrompt } from "../src/resident-host.js";
import { startManagedAgent } from "../src/agent-start.js";

const [name, cwd, socketPath, request = "Run the shell command `touch drovr-permission-probe.txt` with the Bash tool. Nothing else."] = process.argv.slice(2);
if (!name?.startsWith("drovr-proof-") || !cwd?.startsWith("/tmp/drovr-herdr-proof.") || !socketPath?.endsWith(`/sessions/${name}/herdr.sock`)) {
  throw new Error("Explicit new drovr-proof session, temporary cwd, and matching socket required");
}
const client = new DrovrClient({ socketPath, timeoutMs: 40_000 });
const created = await client.workspace.create({ cwd, label: "drovr permission-probe", focus: false });
const paneId = created.root_pane.pane_id;
await startManagedAgent(client, { kind: "claude", name: "permission-probe", pane_id: paneId, args: ["--permission-mode", "default"], timeout_ms: 60_000 }, { readinessTimeoutMs: 10_000 })
  .catch((error) => { if (error?.code !== "agent_not_ready") throw error; });
const screen = async () => (await client.agent.read({ target: paneId, source: "visible", strip_ansi: true })).read.text;
for (let i = 0; i < 60; i++) {
  const prompt = classifyStartupPrompt(await screen());
  if (prompt && "keys" in prompt) await client.agent.sendKeys({ target: paneId, keys: prompt.keys });
  const agent = (await client.agent.get(paneId)).agent;
  if (!prompt && agent.interactive_ready) break;
  await Bun.sleep(1000);
}
await client.agent.prompt({ target: paneId, text: request });
for (let i = 0; i < 60; i++) {
  await Bun.sleep(1000);
  const agent = (await client.agent.get(paneId)).agent;
  if (agent.agent_status === "blocked" || agent.agent_status === "idle" || agent.agent_status === "done") {
    console.log(JSON.stringify({ status: agent.agent_status, paneId }));
    console.log(await screen());
    break;
  }
}
console.log(JSON.stringify({ paneId, workspaceId: created.workspace.workspace_id }));
process.exit(0);
