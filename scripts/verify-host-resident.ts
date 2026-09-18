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
process.exit(resumed.ok ? 0 : 1);
