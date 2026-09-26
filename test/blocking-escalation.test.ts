import { describe, expect, test } from "bun:test";
import { createBlockingEscalationWatcher, type BlockingEscalationHook } from "../src/blocking-escalation.js";

const TRUST = " Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel";
const MCP = "New MCP server found in this project\n❯ 1. Use this and all future MCP servers\n  2. Continue without\nEnter to confirm";
const PERMISSION = "─────────────────────────\n Bash command\n\n   touch x\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend";
const UNKNOWN_A = "  Something Claude Code added last week?\n\n  ❯ 1. Sure\n    2. Later\n\n  Enter to confirm · Esc to cancel";
const UNKNOWN_B = "  A different unknown menu?\n\n  ❯ 1. Yep\n    2. Nope\n\n  Enter to confirm · Esc to cancel";
const IDLE = "❯ some idle shell prompt, no dialog";

interface Agent { pane_id: string; agent_status: string; cwd?: string; agent_session?: { kind: string; value: string }; name?: string }

function client(agents: Agent[], screens: Record<string, string | Error>, sentKeys: { paneId: string; keys: string[] }[] = []) {
  return {
    agent: {
      list: async () => ({ agents: agents.map((a) => ({ ...a, agent: "claude" })) }) as never,
      read: async (p: { target: string }) => {
        const screen = screens[p.target];
        if (screen instanceof Error) throw screen;
        return { read: { text: screen ?? IDLE } } as never;
      },
      sendKeys: async (p: { target: string; keys: string[] }) => { sentKeys.push({ paneId: p.target, keys: p.keys }); return {} as never; },
    },
  };
}

function recordingHook(): BlockingEscalationHook & { escalations: unknown[]; resolutions: unknown[] } {
  const escalations: unknown[] = [];
  const resolutions: unknown[] = [];
  return {
    escalations, resolutions,
    onUnknownDialog: async (e) => { escalations.push(e); },
    onDialogResolved: async (r) => { resolutions.push(r); },
  };
}

describe("createBlockingEscalationWatcher", () => {
  test("presses the keys for a known-safe startup prompt and never calls the hook for it", async () => {
    const sent: { paneId: string; keys: string[] }[] = [];
    const c = client([{ pane_id: "w1:p1", agent_status: "blocked" }], { "w1:p1": TRUST }, sent);
    const hook = recordingHook();
    const outcomes = await createBlockingEscalationWatcher(hook).poll(c);
    expect(outcomes).toEqual([{ paneId: "w1:p1", outcome: "answered", name: "trust" }]);
    expect(sent).toEqual([{ paneId: "w1:p1", keys: ["down", "enter"] }]);
    expect(hook.escalations).toEqual([]);
  });

  test("an MCP approval and a tool-permission prompt are reported, never pressed nor escalated", async () => {
    const c = client(
      [{ pane_id: "w1:p1", agent_status: "blocked" }, { pane_id: "w2:p1", agent_status: "blocked" }],
      { "w1:p1": MCP, "w2:p1": PERMISSION },
    );
    const hook = recordingHook();
    const outcomes = await createBlockingEscalationWatcher(hook).poll(c);
    expect(outcomes).toEqual([
      { paneId: "w1:p1", outcome: "reported", kind: "startup", name: "mcp-approval" },
      { paneId: "w2:p1", outcome: "reported", kind: "permission", name: "Bash command" },
    ]);
    expect(hook.escalations).toEqual([]);
  });

  test("an unknown dialog escalates once, with the full host-neutral payload, and never again for the same episode", async () => {
    const c = client(
      [{ pane_id: "w1:p1", agent_status: "blocked", cwd: "/home/agent/nexus", name: "nexus", agent_session: { kind: "id", value: "s1" } }],
      { "w1:p1": UNKNOWN_A },
    );
    const hook = recordingHook();
    const watcher = createBlockingEscalationWatcher(hook);

    const first = await watcher.poll(c);
    expect(first).toEqual([{ paneId: "w1:p1", outcome: "escalated", fingerprint: expect.any(String) }]);
    expect(hook.escalations).toEqual([{
      paneId: "w1:p1", label: "nexus", sessionId: "s1", cwd: "/home/agent/nexus", herdrStatus: "blocked",
      question: "Something Claude Code added last week?", options: ["Sure", "Later"], fingerprint: expect.any(String),
    }]);

    const second = await watcher.poll(c);
    expect(second).toEqual([]); // same (pane, fingerprint) episode: no repeat call
    expect(hook.escalations).toHaveLength(1);
  });

  test("clearing the dialog resolves the open episode exactly once; a pane that stays unreadable is left open, not resolved on a guess", async () => {
    const screens: Record<string, string | Error> = { "w1:p1": UNKNOWN_A, "w2:p1": UNKNOWN_A };
    const c = client([{ pane_id: "w1:p1", agent_status: "blocked" }, { pane_id: "w2:p1", agent_status: "blocked" }], screens);
    const hook = recordingHook();
    const watcher = createBlockingEscalationWatcher(hook);

    await watcher.poll(c);
    expect(hook.escalations).toHaveLength(2);

    screens["w1:p1"] = IDLE; // w1's dialog cleared
    screens["w2:p1"] = new Error("gone"); // w2 could not be read this poll — unknown, not cleared
    const outcomes = await watcher.poll(c);
    expect(outcomes).toContainEqual({ paneId: "w1:p1", outcome: "resolved", fingerprint: expect.any(String) });
    expect(outcomes.some((o) => o.paneId === "w2:p1" && o.outcome === "resolved")).toBe(false);
    expect(hook.resolutions).toEqual([{ paneId: "w1:p1", fingerprint: expect.any(String) }]);

    screens["w2:p1"] = IDLE; // now genuinely cleared
    const third = await watcher.poll(c);
    expect(third).toContainEqual({ paneId: "w2:p1", outcome: "resolved", fingerprint: expect.any(String) });
    expect(hook.resolutions).toHaveLength(2);
  });

  test("a different dialog replacing an open one on the same pane resolves the old episode and escalates the new one", async () => {
    const screens: Record<string, string> = { "w1:p1": UNKNOWN_A };
    const c = client([{ pane_id: "w1:p1", agent_status: "blocked" }], screens);
    const hook = recordingHook();
    const watcher = createBlockingEscalationWatcher(hook);

    await watcher.poll(c);
    expect(hook.escalations).toHaveLength(1);

    screens["w1:p1"] = UNKNOWN_B;
    const outcomes = await watcher.poll(c);
    expect(outcomes).toEqual([
      { paneId: "w1:p1", outcome: "resolved", fingerprint: expect.any(String) },
      { paneId: "w1:p1", outcome: "escalated", fingerprint: expect.any(String) },
    ]);
    expect(hook.escalations).toHaveLength(2);
    expect(hook.resolutions).toHaveLength(1);
  });

  test("a hook rejection is reported per-pane and never thrown, so one failing pane cannot fail the whole poll", async () => {
    const c = client(
      [{ pane_id: "w1:p1", agent_status: "blocked" }, { pane_id: "w2:p1", agent_status: "blocked" }],
      { "w1:p1": UNKNOWN_A, "w2:p1": UNKNOWN_B },
    );
    const hook: BlockingEscalationHook = {
      onUnknownDialog: async (e) => { if (e.paneId === "w1:p1") throw new Error("boom"); },
      onDialogResolved: async () => undefined,
    };
    const outcomes = await createBlockingEscalationWatcher(hook).poll(c);
    expect(outcomes).toContainEqual({ paneId: "w1:p1", outcome: "hook-failed", phase: "escalate", detail: "boom" });
    expect(outcomes).toContainEqual({ paneId: "w2:p1", outcome: "escalated", fingerprint: expect.any(String) });
  });
});
