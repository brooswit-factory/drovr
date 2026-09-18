// Opt-in proof of listPendingPermissions/approvePermission against a named
// drovr-proof herdr session whose pane is waiting on a real permission prompt
// (see probe-permission-prompt.ts). Never a default socket.
import { existsSync, readFileSync } from "node:fs";
import { DrovrClient } from "../src/drovr-client.js";
import { approvePermission, listPendingPermissions } from "../src/permission-approval.js";

const [name, cwd, socketPath] = process.argv.slice(2);
if (!name?.startsWith("drovr-proof-") || !cwd?.startsWith("/tmp/drovr-herdr-proof.") || !socketPath?.endsWith(`/sessions/${name}/herdr.sock`)) {
  throw new Error("Explicit new drovr-proof session, temporary cwd, and matching socket required");
}
const client = new DrovrClient({ socketPath, timeoutMs: 40_000 });
const auditPath = `${cwd}/permission-audit.jsonl`;
const pending = await listPendingPermissions(client);
console.log(JSON.stringify({ stage: "pending", pending: pending.map(({ paneId, tool, request, promptId, cursor, options }) => ({ paneId, tool, request, promptId, cursor, options })) }));
const target = pending[0];
if (!target) process.exit(1);
const stale = await approvePermission(client, { paneId: target.paneId, promptId: "0000000000000000", operator: "lead-drovr-proof", auditPath });
console.log(JSON.stringify({ stage: "stale-id-refused", stale }));
const approved = await approvePermission(client, { paneId: target.paneId, promptId: target.promptId, operator: "lead-drovr-proof", auditPath });
console.log(JSON.stringify({ stage: "approved", approved }));
await Bun.sleep(8_000);
const touched = existsSync(`${cwd}/drovr-permission-probe.txt`);
console.log(JSON.stringify({ stage: "tool-ran", touched, stillPending: (await listPendingPermissions(client)).length }));
console.log(readFileSync(auditPath, "utf8"));
process.exit(approved.ok && touched && !stale.ok ? 0 : 1);
