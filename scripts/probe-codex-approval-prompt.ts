// Opt-in probe: start real codex in its default (manual, non-bypass) approval
// mode in a named drovr-proof herdr session, answer the one-time directory
// trust dialog, ask it to do something that needs approval, and print the
// resulting screen as soon as a `command` or `file-edit` dialog is detected —
// or every 2s up to a cap, so a human can read off wording this module
// doesn't yet recognise. Used to capture the FACTORY-107 fixtures under
// test/fixtures/codex-approval/. Never run against a shared/live session.
//
// The `mcp-tool` fixture needs an additional companion MCP server registered
// with `codex mcp add` before this script starts codex; that one-off setup
// is not automated here (see docs/codex-permission-approval.md).
import { classifyCodexApprovalScreen } from "../src/codex-permission-approval.js";
import { DrovrClient } from "../src/drovr-client.js";

const [name, cwd, socketPath, request] = process.argv.slice(2);
if (!name?.startsWith("drovr-proof-") || !cwd?.startsWith("/tmp/drovr-herdr-proof.") || !socketPath?.endsWith(`/sessions/${name}/herdr.sock`)) {
  throw new Error("Explicit new drovr-proof session, temporary cwd, and matching socket required");
}
if (!request) throw new Error("A request (prompt) is required as the 4th argument, e.g. a shell command outside cwd or a network fetch");

const client = new DrovrClient({ socketPath, timeoutMs: 40_000 });
const created = await client.workspace.create({ cwd, label: "drovr codex-approval-probe", focus: false });
const paneId = created.root_pane.pane_id;
const screen = async () => (await client.agent.read({ target: paneId, source: "visible", strip_ansi: true })).read.text;

await client.agent.start({ kind: "codex", name: "codex-approval-probe", pane_id: paneId, args: ["--cd", cwd], timeout_ms: 60_000 })
  .catch((error) => { console.log("start error (may still be starting):", error?.message ?? error); });

// Codex's one-time "Do you trust the contents of this directory?" dialog
// (src/codex-trust.ts detects and marks it `blocked`, but never answers it) —
// option 1 "Yes, continue" is the cursor default, so plain enter accepts it.
for (let i = 0; i < 30; i++) {
  const text = await screen().catch(() => "");
  if (/Do you trust the contents of this directory\?/.test(text)) {
    await client.agent.sendKeys({ target: paneId, keys: ["enter"] });
    break;
  }
  if (/›\s*$/m.test(text) || text.includes("Tip:")) break; // already past it
  await Bun.sleep(1000);
}
await Bun.sleep(1000);
await client.agent.prompt({ target: paneId, text: request });

for (let i = 0; i < 60; i++) {
  await Bun.sleep(2000);
  const text = await screen().catch((error) => `<<read error: ${error?.message ?? error}>>`);
  const classified = classifyCodexApprovalScreen(text);
  if (classified) {
    console.log(`\n=== approval prompt detected at t+${(i + 1) * 2}s: kind=${classified.kind} ===`);
    console.log(text);
    console.log(JSON.stringify({ paneId, workspaceId: created.workspace.workspace_id }));
    process.exit(0);
  }
}
console.log("\n=== no approval prompt detected within the time budget; last screen: ===");
console.log(await screen().catch((error) => `<<read error: ${error?.message ?? error}>>`));
console.log(JSON.stringify({ paneId, workspaceId: created.workspace.workspace_id }));
