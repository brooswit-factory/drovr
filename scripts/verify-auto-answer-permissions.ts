// Opt-in proof of autoAnswerPermissions against a named drovr-proof herdr
// session with two real Claude panes in default (ask) permission mode: one
// on a Bash-tool dialog whose option 2 is the "always allow" stored-rule
// option (positive path), one on a Read-tool dialog outside the project
// whose option 2 is a session-only allow, not a "Yes, and …" one (negative
// path). Never a default socket, never a real agent's pane.
import { existsSync, readFileSync } from "node:fs";
import { DrovrClient } from "../src/drovr-client.js";
import { classifyStartupPrompt } from "../src/resident-host.js";
import { startManagedAgent } from "../src/agent-start.js";
import { autoAnswerPermissions, listPendingPermissions } from "../src/permission-approval.js";

const [name, cwd, socketPath] = process.argv.slice(2);
if (!name?.startsWith("drovr-proof-") || !cwd?.startsWith("/tmp/drovr-herdr-proof.") || !socketPath?.endsWith(`/sessions/${name}/herdr.sock`)) {
  throw new Error("Explicit new drovr-proof session, temporary cwd, and matching socket required");
}
const client = new DrovrClient({ socketPath, timeoutMs: 40_000 });
const auditPath = `${cwd}/permission-audit.jsonl`;

async function openDialog(label: string, subdir: string, request: string): Promise<string> {
  const paneCwd = `${cwd}/${subdir}`;
  await Bun.$`mkdir -p ${paneCwd}`;
  const created = await client.workspace.create({ cwd: paneCwd, label: `drovr ${label}`, focus: false });
  const paneId = created.root_pane.pane_id;
  await startManagedAgent(client, { kind: "claude", name: label, pane_id: paneId, args: ["--permission-mode", "default"], timeout_ms: 60_000 }, { readinessTimeoutMs: 10_000 })
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
    if (agent.agent_status === "blocked" || agent.agent_status === "idle" || agent.agent_status === "done") break;
  }
  return paneId;
}

let verdict = false;
try {
  // Positive: a plain Bash command in a fresh project dir — option 2 is "Yes, and always allow …".
  const positivePane = await openDialog("verify-auto-answer-pos", "pos", "Run the shell command `touch drovr-permission-probe.txt` with the Bash tool. Nothing else.");
  // Negative: a Read outside the project dir — option 2 is "Yes, allow reading from /etc during this session", not a "Yes, and …" option.
  const negativePane = await openDialog("verify-auto-answer-neg", "neg", "Use the Read tool to read the file /etc/hostname. Nothing else.");

  const before = await listPendingPermissions(client);
  console.log(JSON.stringify({ stage: "pending-before", pending: before.map(({ paneId, tool, options }) => ({ paneId, tool, options })) }));

  const results = await autoAnswerPermissions(client, { auditPath });
  console.log(JSON.stringify({ stage: "pass-1", results }));

  await Bun.sleep(5_000);
  const touched = existsSync(`${cwd}/pos/drovr-permission-probe.txt`);
  const after = await listPendingPermissions(client);
  console.log(JSON.stringify({ stage: "after", touched, stillPending: after.map(({ paneId, tool }) => ({ paneId, tool })) }));

  const auditExists = existsSync(auditPath);
  const audit = auditExists ? readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  console.log(JSON.stringify({ stage: "audit", audit }));

  const positiveResult = results.find((r) => r.paneId === positivePane);
  const negativeResult = results.find((r) => r.paneId === negativePane);
  const positiveOk = positiveResult?.outcome === "answered" && touched;
  const negativeOk = negativeResult?.outcome === "skipped" && !audit.some((record) => record.paneId === negativePane);
  const auditOk = audit.length === 2 && audit.every((record) => record.paneId === positivePane && record.operator === "drovr-auto")
    && audit[0].outcome === "approving" && audit[1].outcome === "approved" && audit[1].option?.startsWith("Yes, and always allow");
  const clearedOk = !after.some((p) => p.paneId === positivePane);

  console.log(JSON.stringify({ stage: "verdict", positiveOk, negativeOk, auditOk, clearedOk }));
  verdict = positiveOk && negativeOk && auditOk && clearedOk;

  await client.agent.sendKeys({ target: negativePane, keys: ["escape"] }).catch(() => undefined);
} finally {
  const stopped = Bun.spawnSync(["herdr", "session", "stop", name, "--json"]);
  console.log(JSON.stringify({ stage: "session-cleanup", exitCode: stopped.exitCode, result: stopped.stdout.toString().trim() }));
}

process.exit(verdict ? 0 : 1);
