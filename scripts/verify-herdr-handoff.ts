// Opt-in proof against an explicitly created named test session; never a default socket.
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { DrovrClient } from "../src/drovr-client.js";
import { ManagedHerdrLifecycle } from "../src/managed-herdr-lifecycle.js";
import { inventoryCodexMcpServers } from "../src/agent-runtime.js";
import { prepareAgyHome } from "../src/agy-home.js";
import { nativeTranscriptReply, readNativeTranscript } from "../src/native-transcript.js";

const [name, cwd, socketPath] = process.argv.slice(2);
if (!name?.startsWith("drovr-proof-") || !cwd?.startsWith("/tmp/drovr-herdr-proof.") || !socketPath?.endsWith(`/sessions/${name}/herdr.sock`)) {
  throw new Error("Explicit new drovr-proof session, temporary cwd, and matching socket required");
}
const client = new DrovrClient({ socketPath, timeoutMs: 40_000 });
const lifecycle = new ManagedHerdrLifecycle({ client, cwd, acknowledgementTimeoutMs: 90_000, startOptions: { readinessTimeoutMs: 20_000 } });
const fact = "The calibration phrase is SILVER-CEDAR-4827.";
const instruction = "This is a memory-only test. Do not use tools, access files, or perform task work.";
const codexHome = homedir();
async function installIntegration(provider: "codex" | "antigravity-cli", home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (provider === "codex") await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
  const result = Bun.spawnSync(["herdr", "integration", "install", provider], {
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") },
  });
  if (result.exitCode !== 0) throw new Error(`Private ${provider} integration installation failed: ${result.stderr.toString()}`);
  console.log(JSON.stringify({ stage: "private-integration-installed", provider, home }));
}
async function reply(expected: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = lifecycle.current!;
    const { agent } = await client.agent.get(current.paneId);
    if (agent.agent_session && (agent.agent_status === "idle" || agent.agent_status === "done")) {
      const text = await readNativeTranscript({ provider: current.provider, session: agent.agent_session, cwd: current.cwd, ...(current.home ? { home: current.home } : {}) });
      const output = nativeTranscriptReply(current.provider, text);
      if (output?.trim() === expected) return output;
    }
    await Bun.sleep(500);
  }
  if (lifecycle.current) console.log(JSON.stringify({ stage: "reply-timeout", agent: (await client.agent.get(lifecycle.current.paneId)).agent, screen: await client.pane.read({ pane_id: lifecycle.current.paneId, source: "detection", strip_ansi: true }) }));
  throw new Error("Native model reply was not observed before the deadline");
}
try {
  await installIntegration("codex", codexHome);
  const inventory = inventoryCodexMcpServers();
  if (!inventory.ok) throw new Error(inventory.reason);
  const initial = await lifecycle.start({
    priority: [{ provider: "codex", accountId: "default" }], label: "memory-proof",
    kickoff: () => `${instruction} Remember this fact for later: ${fact} Reply only MEMORY_STORED.`,
    prepare: async () => ({ home: codexHome, env: { CODEX_HOME: join(codexHome, ".codex"), CODEX_THREAD_ID: "" }, launch: { provider: "codex", cwd, name: "proof-codex", paneId: "pending", prompt: "", mcpServers: [], disabledMcpServers: inventory.servers, bypassApprovalsAndSandbox: false } }),
  });
  console.log(JSON.stringify({ stage: "initial", result: initial }));
  if (initial.status !== "success") {
    console.log(JSON.stringify({ stage: "initial-agents", agents: (await client.agent.list()).agents }));
    if (lifecycle.current) console.log(JSON.stringify({ stage: "initial-screen-diagnostic", read: await client.pane.read({ pane_id: lifecycle.current.paneId, source: "detection", strip_ansi: true }) }));
    throw new Error("Initial worker did not start");
  }
  await reply("MEMORY_STORED");
  console.log(JSON.stringify({ stage: "source-memory-confirmed", pane: lifecycle.current?.paneId }));
  const oldPane = lifecycle.current!.paneId;
  const result = await lifecycle.start({
    priority: [{ provider: "agy", accountId: "default" }], label: "memory-proof", replacePaneId: oldPane,
    reason: "Verify no-tools memory transfer from Codex to AGY",
    kickoff: () => `${instruction} What is the calibration phrase from our imported conversation? Reply with only the phrase.`,
    prepare: async () => {
      const home = join(cwd, "agy-home");
      const env = await prepareAgyHome({ home, cwd, servers: {}, setupFromHome: homedir(), installHerdrIntegration: true });
      return { home, env, launch: { provider: "agy", cwd, name: "proof-agy", paneId: "pending", prompt: "" } };
    },
  });
  console.log(JSON.stringify({ stage: "handoff", result }));
  if (result.status !== "success") throw new Error("Handoff did not complete");
  const recalled = await reply("SILVER-CEDAR-4827");
  const { agents } = await client.agent.list();
  if (agents.some(a => a.pane_id === oldPane)) throw new Error("Old pane was not retired");
  console.log(JSON.stringify({ stage: "proof", recalled, current: lifecycle.current, oldRetired: true }));
} finally {
  await lifecycle.stop().catch(error => console.log(JSON.stringify({ stage: "worker-cleanup", error: String(error) })));
  const stopped = Bun.spawnSync(["herdr", "session", "stop", name, "--json"]);
  console.log(JSON.stringify({ stage: "session-cleanup", exitCode: stopped.exitCode, result: stopped.stdout.toString().trim() }));
}
