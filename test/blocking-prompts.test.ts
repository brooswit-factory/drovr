import { describe, expect, test } from "bun:test";
import { classifyBlockingScreen, listBlockingPrompts, scanBlockingPrompts } from "../src/blocking-prompts.js";

// Screens measured on this host, 2026-09-18.
const TRUST = " Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel";
const PERMISSION = [
  "─────────────────────────────────────────",
  " Bash command",
  "",
  "   touch drovr-permission-probe.txt",
  "   Create empty probe file",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to /tmp/x from this project",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");
const ONBOARDING = "  Teach auto mode about your environment?\n\n  ❯ 1. Yes\n    2. Not now\n    3. Don't show again\n\n  Enter to confirm · Esc to cancel";
const NEVER_SEEN = "  Something Claude Code added last week?\n\n  ❯ 1. Sure\n    2. Later\n\n  Enter to confirm · Esc to cancel";
// lead-factory-dashboard's pane once unstuck: a quoted menu name in the transcript, no waiting footer.
const IDLE = [
  "● I've saved the routing rule. The \"Teach auto mode about your environment?\" menu is answered.",
  "",
  "✻ Worked for 2s · done 12:21 PM · 1 monitor still running",
  "──────────────────────── factory-dashboard daemon implementation ─",
  "❯ yes, post the intro in #general",
  "────────────────────────────────────────",
  "  ⏵⏵ auto mode on · 1 monitor · ← for agents · ↓ to manage",
].join("\n");

describe("classifyBlockingScreen", () => {
  test("names the prompts Drovr answers, and marks anything else waiting as unknown", () => {
    expect(classifyBlockingScreen(TRUST)).toMatchObject({ kind: "startup", name: "trust" });
    expect(classifyBlockingScreen(ONBOARDING)).toMatchObject({ kind: "startup", name: "auto-mode-onboarding" });
    expect(classifyBlockingScreen(PERMISSION)).toMatchObject({ kind: "permission", name: "Bash command" });
    const unknown = classifyBlockingScreen(NEVER_SEEN)!;
    expect(unknown.kind).toBe("unknown");
    expect(unknown.excerpt).toContain("Something Claude Code added last week?");
  });

  test("a screen waiting on nothing is not reported, even when its transcript quotes a prompt", () => {
    expect(classifyBlockingScreen(IDLE)).toBeUndefined();
    expect(classifyBlockingScreen("")).toBeUndefined();
  });
});

describe("listBlockingPrompts", () => {
  test("reads every Claude pane whatever herdr says, and skips panes it cannot read", async () => {
    const screens: Record<string, string | Error> = { "w1:p1": NEVER_SEEN, "w2:p1": IDLE, "w3:p1": new Error("gone"), "w4:p1": TRUST };
    const client = {
      agent: {
        list: async () => ({ type: "agent_list", agents: [
          { pane_id: "w1:p1", agent: "claude", name: "nexus", agent_status: "done", agent_session: { kind: "id", value: "s1" }, cwd: "/a" },
          { pane_id: "w2:p1", agent: "claude", name: "dash", agent_status: "idle" },
          { pane_id: "w3:p1", agent: "claude", name: "gone", agent_status: "blocked" },
          { pane_id: "w4:p1", agent: "claude", name: "fresh", agent_status: "blocked" },
          { pane_id: "w5:p1", agent: "codex", name: "codex", agent_status: "blocked" },
        ] }) as never,
        read: async (p: { target: string }) => {
          const screen = screens[p.target];
          if (screen instanceof Error || screen === undefined) throw screen ?? new Error("no pane");
          return { type: "pane_read", read: { text: screen } } as never;
        },
      },
    };
    const found = await listBlockingPrompts(client);
    expect(found.map((f) => [f.paneId, f.label, f.herdrStatus, f.kind, f.name])).toEqual([
      ["w1:p1", "nexus", "done", "unknown", undefined],
      ["w4:p1", "fresh", "blocked", "startup", "trust"],
    ]);
    expect(found[0]!.sessionId).toBe("s1");
  });
});

describe("scanBlockingPrompts", () => {
  test("an unreadable pane is reported, never silently treated as 'not blocked'; a hung read is bounded by readTimeoutMs, not left open", async () => {
    let hungReadWasCalled = false;
    const client = {
      agent: {
        list: async () => ({ type: "agent_list", agents: [
          { pane_id: "w1:p1", agent: "claude", name: "fine", agent_status: "blocked", agent_session: { kind: "id", value: "s1" }, cwd: "/a" },
          { pane_id: "w2:p1", agent: "claude", name: "broken", agent_status: "idle" },
          { pane_id: "w3:p1", agent: "claude", name: "hung", agent_status: "idle" },
        ] }) as never,
        read: async (p: { target: string }) => {
          if (p.target === "w1:p1") return { type: "pane_read", read: { text: TRUST } } as never;
          if (p.target === "w2:p1") throw new Error("gone");
          hungReadWasCalled = true;
          // Simulates a wedged `agent.read` that never settles.
          return new Promise<never>(() => undefined);
        },
      },
    };
    // The test seam (`readWait`) replaces the real per-read timer with a
    // microtask-ordered stand-in: it yields a fixed number of microtask
    // ticks, comfortably more than a genuinely resolving read ever takes, so
    // a normal read still wins its race deterministically while the hung
    // read — which never settles at all — always eventually loses to it.
    // No wall-clock time is ever waited on, even though readTimeoutMs is set
    // to 1500.
    const flush = async (ticks = 20) => { for (let i = 0; i < ticks; i++) await Promise.resolve(); };
    const startedAt = Date.now();
    const result = await scanBlockingPrompts(client, { readTimeoutMs: 1500, readWait: () => flush() });
    expect(hungReadWasCalled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(result.prompts).toEqual([{
      paneId: "w1:p1", label: "fine", sessionId: "s1", cwd: "/a", herdrStatus: "blocked",
      kind: "startup", name: "trust", excerpt: expect.any(String),
    }]);
    expect(result.unreadable).toHaveLength(2);
    const byPane = Object.fromEntries(result.unreadable.map((u) => [u.paneId, u]));
    expect(byPane["w2:p1"]).toMatchObject({ label: "broken", herdrStatus: "idle", reason: "error", detail: "gone" });
    expect(byPane["w3:p1"]).toMatchObject({ label: "hung", herdrStatus: "idle", reason: "timeout" });
    expect((byPane["w3:p1"] as { detail: string }).detail).toContain("1500");
  });

  test("a failure of agent.list() itself still rejects — the caller maps that to 'couldn't check anything'", async () => {
    const client = { agent: { list: async () => { throw new Error("herdr socket gone"); }, read: async () => { throw new Error("unused"); } } };
    await expect(scanBlockingPrompts(client)).rejects.toThrow("herdr socket gone");
  });
});
