/**
 * FACTORY-1037: real end-to-end proof against a REAL, currently running
 * herdr daemon (the default local socket), in an isolated owned workspace,
 * with a deliberately slow shell startup -- not a fake/mocked herdr.
 *
 * It does NOT call herdr's real `agent.start` with `kind: "claude"`: that
 * ignores any per-pane PATH override and launches the real Claude Code
 * binary regardless of what a stub on PATH says (verified live while
 * investigating this ticket) -- spending real API usage and risking an
 * orphaned real session is not an acceptable cost for a smoke test.
 * `client.agent.start` is therefore a local stub that only records the call
 * and the pane's REAL canonical-mode state (via `checkCanonicalMode`,
 * itself backed by a real `/proc/<shell_pid>/fd/0` + `stty -g` read) at the
 * moment it was invoked. `client.pane.processInfo` is the real herdr client
 * throughout -- the timing measured is genuine kernel/shell state, not a
 * simulation of it.
 *
 * Two isolated panes, both given the SAME artificially slow shell startup
 * (a throwaway $HOME whose fish config.fish sleeps before fish becomes
 * interactive -- never touches the real user's shell config):
 *
 *   A) "before": `checkCanonicalMode` forced to report "raw" (as if
 *      FACTORY-1037's gate did not exist). Confirms the FAILURE this
 *      ticket is about is real: agent.start is invoked while the REAL
 *      shell's kernel TTY mode is independently confirmed still
 *      "canonical" -- the exact window in which a long injected line would
 *      be silently truncated with no error (see this PR's own isolated
 *      pty reproduction for that mechanism).
 *   B) "after": the real, unmodified gate. Confirms agent.start is NEVER
 *      invoked until the same kind of real shell has genuinely left
 *      canonical mode, confirmed the same independent way.
 *
 * Cleans up both workspaces and all scratch files, even on failure.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrovrClient } from "../src/drovr-client.js";
import { startManagedAgent } from "../src/agent-start.js";
import { checkCanonicalMode } from "../src/terminal-readiness.js";

const SLOW_STARTUP_SECONDS = Number(process.env.FACTORY_1037_SLOW_SECONDS ?? 4);

/**
 * herdr resolves a new pane's shell from the SAME env object passed to
 * `workspace.create()`, not merged with its own daemon process's
 * environment -- confirmed live (CI): a workspace created with NO `env`
 * override inherited the daemon's fish just fine, but the exact same
 * daemon, given an explicit `env: { HOME: ... }` override with no `SHELL`
 * key, fell back to bash regardless of this host's passwd shell or the
 * daemon's own $SHELL. So every slow pane below must set SHELL itself,
 * explicitly, rather than relying on inheritance.
 */
const FISH_PATH = (() => {
  try { return execFileSync("sh", ["-c", "command -v fish"], { encoding: "utf8" }).trim() || undefined; }
  catch { return undefined; }
})();
if (!FISH_PATH) throw new Error("fish not found on PATH -- this script needs fish installed to reproduce a real slow shell startup (see .github/workflows/ci.yml's canonical-gate-smoke job)");

const scratch = mkdtempSync(join(tmpdir(), "drovr-canonical-gate-smoke-"));
const fishHome = join(scratch, "fish-home");
mkdirSync(join(fishHome, ".config", "fish"), { recursive: true });
writeFileSync(join(fishHome, ".config", "fish", "config.fish"), `sleep ${SLOW_STARTUP_SECONDS}\n`);

const client = new DrovrClient();
const workspaceIds: string[] = [];

async function cleanup(): Promise<void> {
  for (const workspaceId of workspaceIds) await client.workspace.close({ workspace_id: workspaceId }).catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
}

async function createSlowPane(label: string): Promise<string> {
  const created = await client.workspace.create({ label, cwd: scratch, env: { HOME: fishHome, SHELL: FISH_PATH } });
  workspaceIds.push(created.workspace.workspace_id);
  const root = created.root_pane;
  const paneId = typeof root === "string" ? root : root?.pane_id;
  if (!paneId) throw new Error(`${label}: workspace.create returned no pane`);
  return paneId;
}

type StartClientArg = Parameters<typeof startManagedAgent>[0];

function recordingClient(onCall: (canon: Awaited<ReturnType<typeof checkCanonicalMode>>) => void): StartClientArg {
  return {
    agent: {
      start: async (params) => {
        const info = await client.pane.processInfo({ pane_id: params.pane_id });
        const shellPid = info.type === "pane_process_info" ? info.process_info.shell_pid : undefined;
        onCall(shellPid ? await checkCanonicalMode(shellPid) : "unavailable");
        return { type: "agent_started", agent: {}, argv: [] } as never;
      },
    },
    pane: client.pane,
  };
}

async function main(): Promise<void> {
  console.log(`Slow shell startup: config.fish sleeps ${SLOW_STARTUP_SECONDS}s before fish becomes interactive.`);

  // A) before: force the gate to report "raw" immediately, as if it never ran.
  const paneA = await createSlowPane("factory-1037-smoke-before");
  let canonAtCallA: Awaited<ReturnType<typeof checkCanonicalMode>> | undefined;
  await startManagedAgent(recordingClient((canon) => { canonAtCallA = canon; }), { name: "a", pane_id: paneA, kind: "claude", args: ["probe"], timeout_ms: 30_000 }, { checkCanonicalMode: async () => "raw" });
  console.log(`A) without the gate: agent.start fired while the REAL shell's kernel TTY mode was: ${canonAtCallA}`);
  if (canonAtCallA !== "canonical") {
    throw new Error(`A) did not reproduce the dangerous window (shell left canonical mode before the call) -- rerun with FACTORY_1037_SLOW_SECONDS higher than ${SLOW_STARTUP_SECONDS}`);
  }

  // B) after: the real, unmodified gate.
  const paneB = await createSlowPane("factory-1037-smoke-after");
  let canonAtCallB: Awaited<ReturnType<typeof checkCanonicalMode>> | undefined;
  const startedAt = performance.now();
  await startManagedAgent(recordingClient((canon) => { canonAtCallB = canon; }), { name: "b", pane_id: paneB, kind: "claude", args: ["probe"], timeout_ms: 30_000 });
  const waitedMs = performance.now() - startedAt;
  console.log(`B) with the real gate: agent.start fired after waiting ${waitedMs.toFixed(0)}ms, while the REAL shell's kernel TTY mode was: ${canonAtCallB}`);
  if (canonAtCallB === "canonical") throw new Error("B) the real gate let agent.start fire while still canonical -- regression");
  if (waitedMs < SLOW_STARTUP_SECONDS * 1000 * 0.5) throw new Error(`B) returned too fast (${waitedMs.toFixed(0)}ms) to have genuinely waited for the slow shell -- suspicious pass`);

  console.log("OK: reproduced the unsafe window without the gate, and confirmed the real gate avoids it, both against a real herdr.");
}

main()
  .then(() => cleanup())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("FAILED:", e);
    await cleanup();
    process.exit(1);
  });
