// Opt-in proof of hostResident against an explicitly created named test session; never a default socket.
import { DrovrClient } from "../src/drovr-client.js";
import { hostResident, listResidents, stopResident } from "../src/resident-host.js";

const [name, cwd, socketPath] = process.argv.slice(2);
if (!name?.startsWith("drovr-proof-") || !cwd?.startsWith("/tmp/drovr-herdr-proof.") || !socketPath?.endsWith(`/sessions/${name}/herdr.sock`)) {
  throw new Error("Explicit new drovr-proof session, temporary cwd, and matching socket required");
}
const client = new DrovrClient({ socketPath, timeoutMs: 40_000 });
// An untrusted directory plus a development channel: both startup prompts must be answered.
// A first prompt gives the session a transcript, so the resume below has one to continue.
const hosted = await hostResident(client, {
  provider: "claude", cwd, label: "drovr-proof-resident", prompt: "Reply with just the word OK. Do not use tools.",
  inputs: { developmentChannels: ["server:drovr-proof"] },
}, { readyTimeoutMs: 90_000 });
console.log(JSON.stringify({ stage: "hosted", hosted }));
if (!hosted.ok) process.exit(1);
const again = await hostResident(client, { provider: "claude", cwd, label: "drovr-proof-resident" });
console.log(JSON.stringify({ stage: "second-host-same-label", again }));
console.log(JSON.stringify({ stage: "listed", residents: await listResidents(client) }));
// The first turn must start and finish before the stop, or no transcript is written.
await client.agent.wait({ target: hosted.paneId, until: ["working"], timeout_ms: 30_000 }).catch(() => undefined);
const replied = await client.agent.wait({ target: hosted.paneId, until: ["idle", "done"], timeout_ms: 90_000 }).then((r) => r.agent.agent_status, (e) => String(e));
const screen = await client.agent.read({ target: hosted.paneId, source: "recent", strip_ansi: true, lines: 40 }).then((r) => r.read.text, (e) => String(e));
console.log(JSON.stringify({ stage: "first-turn", replied, screen }));
console.log(JSON.stringify({ stage: "stopped", stopped: await stopResident(client, hosted.paneId) }));
console.log(JSON.stringify({ stage: "listed-after-stop", residents: await listResidents(client) }));
// The stopped session's transcript stays; a resume under the same label must pick it up.
const resumed = await hostResident(client, {
  provider: "claude", cwd, label: "drovr-proof-resident", resume: hosted.sessionId,
  inputs: { developmentChannels: ["server:drovr-proof"] },
}, { readyTimeoutMs: 90_000 });
console.log(JSON.stringify({ stage: "resumed", resumed, sameSession: resumed.ok && resumed.sessionId === hosted.sessionId }));
if (resumed.ok) console.log(JSON.stringify({ stage: "stopped-resumed", stopped: await stopResident(client, resumed.paneId) }));
// Observation only: bakr saw claude refuse a resume from another directory
// ("This conversation is from a different directory"); claude 2.1.277
// resumed this session from a sibling directory, so it does not gate the verdict.
const elsewhere = `${cwd}-elsewhere`;
await Bun.$`mkdir -p ${elsewhere}`;
const moved = await hostResident(client, { provider: "claude", cwd: elsewhere, label: "drovr-proof-resident", resume: hosted.sessionId }, { readyTimeoutMs: 90_000 });
console.log(JSON.stringify({ stage: "resume-other-directory", moved }));
if (moved.ok) await stopResident(client, moved.paneId);

// Two panes at once, as a host relaunching several agents does: two labels in
// parallel must both come up, and two starts racing for one label must leave
// exactly one pane holding it, with the loser's workspace closed.
const concurrent = { inputs: { developmentChannels: ["server:drovr-proof"] } };
const [a, b] = await Promise.all([
  hostResident(client, { provider: "claude", cwd, label: "drovr-proof-a", ...concurrent }, { readyTimeoutMs: 90_000 }),
  hostResident(client, { provider: "claude", cwd, label: "drovr-proof-b", ...concurrent }, { readyTimeoutMs: 90_000 }),
]);
const listedTwo = await listResidents(client);
console.log(JSON.stringify({ stage: "two-labels-parallel", a, b, listed: listedTwo.map((r) => [r.label, r.paneId, r.status]) }));
const [r1, r2] = await Promise.all([
  hostResident(client, { provider: "claude", cwd, label: "drovr-proof-race", ...concurrent }, { readyTimeoutMs: 90_000 }),
  hostResident(client, { provider: "claude", cwd, label: "drovr-proof-race", ...concurrent }, { readyTimeoutMs: 90_000 }),
]);
const listedRace = await listResidents(client);
const holders = listedRace.filter((r) => r.label === "drovr-proof-race");
const workspaces = (await client.workspace.list()).workspaces.map((w) => w.label);
console.log(JSON.stringify({ stage: "same-label-race", r1, r2, holders: holders.map((r) => r.paneId), workspaces }));
for (const r of listedRace) await stopResident(client, r.paneId);
const left = await listResidents(client);
console.log(JSON.stringify({ stage: "cleanup", left }));
const pass = resumed.ok && a.ok && b.ok && listedTwo.length === 2 && holders.length === 1 && [r1, r2].filter((r) => r.ok).length === 1
  && workspaces.filter((w) => w === "drovr drovr-proof-race").length === 1 && left.length === 0;
console.log(JSON.stringify({ stage: "verdict", pass }));
process.exit(pass ? 0 : 1);
