import { describe, expect, test } from "bun:test";
import { HerdrError } from "@brooswit/herdr-sdk";
import {
  buildResidentClaudeArgs,
  classifyStartupPrompt,
  hostResident,
  keysToChoose,
  listResidents,
  stopResident,
} from "../src/resident-host.js";

// Measured on claude 2.1.x in a herdr pane, 2026-09-18: unnumbered, cursor on "No, exit".
const TRUST = [
  " /tmp/drovr-herdr-proof.hostres",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
  " well-known open source project, or work from your team). If not, take a moment to review",
  " what's in this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");
const TRUST_NUMBERED = TRUST.replace(" ❯ No, exit\n   Yes, I trust this folder", " ❯ 1. Yes, I trust this folder\n   2. No, exit");
const CHANNELS = [
  "WARNING: Loading development channels",
  "❯ 1. I am using this for local development",
  "  2. Exit",
  "Enter to confirm · Esc to cancel",
].join("\n");
const MCP = "New MCP server found in this project\n❯ 1. Use this and all future MCP servers\n  2. Continue without\nEnter to confirm";
const IDLE_SCREEN = "╭────╮\n│ >  │\n╰────╯";
// SYNTHETIC — invented for this test, not observed or measured anywhere.
// FACTORY-46/FACTORY-44's ticket wording is not reproduced in any fixture,
// log, or live capture in this checkout; worse, `strings` on the installed
// claude 2.1.283 binary shows this exact phrase only inside a
// non-interactive NOTICE with no options and no footer — see
// classifyStartupPrompt's own comment for the full evidence. This fixture
// and the tests below it exercise the matcher's OWN conservative logic
// (require both phrases + an explicit "Not now" option, else fall through)
// on an invented menu shape; they are not evidence the real dialog exists
// or looks like this.
const RENDERER = [
  "Claude Code's fullscreen renderer didn't finish starting last time.",
  "",
  "❯ 1. Try again",
  "  2. Not now",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");
const RENDERER_AMBIGUOUS = RENDERER.replace("2. Not now", "2. Always disable it");
const RENDERER_OFFER = "Try the new fullscreen renderer?\n\n❯ 1. Yes, try it\n  2. Not now\n\nEnter to confirm · Esc to cancel";

interface Agent { pane_id: string; workspace_id: string; name?: string; agent?: string; agent_status: string; interactive_ready?: boolean; cwd?: string; agent_session?: { kind: string; value: string } }

function fixture(opts: { screens?: string[]; agents?: Agent[]; workspaces?: { workspace_id: string; label: string }[]; startError?: unknown | (() => unknown); promptError?: unknown; ready?: boolean } = {}) {
  const screens = [...(opts.screens ?? [])];
  const calls: { method: string; args: unknown }[] = [];
  let time = 0;
  const agents = opts.agents ?? [];
  const client = {
    agent: {
      list: async () => { calls.push({ method: "agent.list", args: undefined }); return { type: "agent_list", agents } as never; },
      get: async (target: string) => {
        calls.push({ method: "agent.get", args: target });
        const known = agents.find((a) => a.pane_id === target);
        if (known) return { type: "agent_info", agent: known } as never;
        if (target !== "w9:p1") throw new Error("no such pane");
        return { type: "agent_info", agent: {
          pane_id: "w9:p1", workspace_id: "w9", agent: "claude", name: "lead-drovr",
          agent_status: screens.length ? "blocked" : "idle", interactive_ready: opts.ready ?? screens.length === 0,
          agent_session: { kind: "id", value: "sess-from-herdr" },
        } } as never;
      },
      read: async (p: unknown) => { calls.push({ method: "agent.read", args: p }); return { type: "pane_read", read: { text: screens[0] ?? IDLE_SCREEN } } as never; },
      prompt: async (p: unknown) => {
        calls.push({ method: "agent.prompt", args: p });
        if (opts.promptError) throw opts.promptError;
        return { type: "agent_prompted" } as never;
      },
      sendKeys: async (p: { keys: string[] }) => { calls.push({ method: "agent.sendKeys", args: p }); screens.shift(); return { type: "ok" } as never; },
      start: async (p: unknown) => {
        calls.push({ method: "agent.start", args: p });
        const error = typeof opts.startError === "function" ? opts.startError() : opts.startError;
        if (error) throw error;
        return { type: "agent_started" } as never;
      },
    },
    pane: {
      processInfo: async (p: { pane_id: string }) => {
        if (p.pane_id !== "w1:p1") throw new Error("no process info");
        return { type: "pane_process_info", process_info: { shell_pid: 10, foreground_processes: [{ pid: 10, name: "bash" }, { pid: 4242, name: "claude" }] } } as never;
      },
      read: async (p: unknown) => { calls.push({ method: "pane.read", args: p }); return { type: "pane_read", read: { text: "" } } as never; },
    },
    workspace: {
      create: async (p: unknown) => { calls.push({ method: "workspace.create", args: p }); return { type: "workspace_created", root_pane: { pane_id: "w9:p1" }, workspace: { workspace_id: "w9" } } as never; },
      close: async (p: unknown) => { calls.push({ method: "workspace.close", args: p }); return { type: "ok" } as never; },
      list: async () => { calls.push({ method: "workspace.list", args: undefined }); return { type: "workspace_list", workspaces: opts.workspaces ?? [] } as never; },
    },
  };
  const now = () => time, wait = async (ms: number) => { time += ms; };
  const options = { now, wait, mintSessionId: () => "minted-session", readyTimeoutMs: 10_000, pollIntervalMs: 1_000, startOptions: { now, wait } };
  const called = (method: string) => calls.filter((c) => c.method === method).map((c) => c.args);
  return { client, calls, called, options };
}

const request = { provider: "claude" as const, cwd: "/home/agent/project", label: "lead-drovr" };

describe("startup prompts", () => {
  test("trust is answered by moving the cursor onto the trust option, wherever it is", () => {
    expect(classifyStartupPrompt(TRUST)).toEqual({ kind: "trust", keys: ["down", "enter"] });
    expect(classifyStartupPrompt(TRUST_NUMBERED)).toEqual({ kind: "trust", keys: ["enter"] });
  });

  test("the auto-mode onboarding offer gets Yes, read from the measured live screen", () => {
    // Measured on lead-factory-dashboard's pane wP:p1, 2026-09-18: transcript above, input box below.
    const screen = [
      "● I've saved the routing rule to my chat memory note.",
      "",
      "────────────────────────────────────────",
      "  Teach auto mode about your environment?",
      "",
      "  Auto mode works better when it knows your environment. Takes about a minute.",
      "",
      "  ❯ 1. Yes",
      "    2. Not now",
      "    3. Don't show again",
      "",
      "  Enter to confirm · Esc to cancel",
      "──────────────────────── factory-dashboard daemon implementation ─",
      "❯ yes, post the intro in #general",
      "────────────────────────────────────────",
    ].join("\n");
    expect(classifyStartupPrompt(screen)).toEqual({ kind: "auto-mode-onboarding", keys: ["enter"] });
  });

  // The setup's second screen: nexus-admin's pane wF:p1, 2026-09-18, as read by lead-drovr and by lead-bakr.
  const setup = (shell: string, repos: string, cursorOn: "shell" | "repos" | "continue") => [
    "✻ Worked for 39s · done 12:22 PM · 1 monitor still running",
    "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
    "   Teach auto mode about your environment?",
    "",
    "   Claude Code reads this project, your recent Claude sessions, and optionally your shell history and other repositories. Claude analyzes this data and customizes auto mode to make better",
    "   decisions.",
    "",
    "     How you use Claude here    ◀ Mixed ▶",
    `   ${cursorOn === "shell" ? "❯" : " "} Also scan shell history    [${shell}]`,
    `   ${cursorOn === "repos" ? "❯" : " "} Also scan your other repos [${repos}]`,
    "",
    `   ${cursorOn === "continue" ? "❯" : " "} Continue`,
    "",
    "   ←/→ to change usage · Enter to continue · Esc to cancel",
  ].join("\n");

  test("the setup screen ticks each unticked box, one per read, before anything else", () => {
    expect(classifyStartupPrompt(setup(" ", " ", "shell"))).toEqual({ kind: "auto-mode-onboarding", keys: ["space"] });
    expect(classifyStartupPrompt(setup("✔", " ", "shell"))).toEqual({ kind: "auto-mode-onboarding", keys: ["down", "space"] });
  });

  test("Continue is pressed only once the screen shows both boxes ticked", () => {
    expect(classifyStartupPrompt(setup("✔", "✔", "repos"))).toEqual({ kind: "auto-mode-onboarding", keys: ["down", "enter"] });
    for (const [shell, repos] of [[" ", " "], ["✔", " "], [" ", "✔"]] as const) {
      for (const cursorOn of ["shell", "repos", "continue"] as const) {
        const prompt = classifyStartupPrompt(setup(shell, repos, cursorOn));
        expect(prompt && "keys" in prompt ? prompt.keys.at(-1) : undefined).toBe("space");
      }
    }
  });

  test("existing auto-mode entries are added to, never replaced", () => {
    // Measured on yappr-3's pane wQ:p1, 2026-09-18, after "Yes" on an account that already has entries.
    const existing = [
      "  You already have auto-mode entries — add to them, or start fresh?",
      "",
      "  ❯ 1. Add to them (keeps your existing entries)",
      "    2. Start fresh (replaces the environment section)",
      "    3. Cancel",
      "",
      "  Enter to continue · Esc to cancel",
    ].join("\n");
    expect(classifyStartupPrompt(existing)).toEqual({ kind: "auto-mode-onboarding", keys: ["enter"] });
    const cursorOnFresh = existing.replace("❯ 1. Add", "  1. Add").replace("    2. Start", "  ❯ 2. Start");
    expect(classifyStartupPrompt(cursorOnFresh)).toEqual({ kind: "auto-mode-onboarding", keys: ["up", "enter"] });
  });

  test("the setup's review screen is saved, as decided, whichever option the cursor starts on", () => {
    // Measured on yappr-3's pane wQ:p1, 2026-09-18 (the tail of a long generated review).
    const review = "  Extra hard blocks\n   none suggested\n\n  ❯ Looks good — save it\n    Discard and exit\n\n  Enter to confirm · Esc to cancel";
    expect(classifyStartupPrompt(review)).toEqual({ kind: "auto-mode-onboarding", keys: ["enter"] });
    const onDiscard = review.replace("❯ Looks good", "  Looks good").replace("    Discard", "  ❯ Discard");
    expect(classifyStartupPrompt(onDiscard)).toEqual({ kind: "auto-mode-onboarding", keys: ["up", "enter"] });
  });

  test("the menu's cursor is the one above its footer, not an earlier prompt line in the transcript", () => {
    const resumed = "❯ an earlier prompt from the transcript\n\n● reply\n\n" + TRUST;
    expect(classifyStartupPrompt(resumed)).toEqual({ kind: "trust", keys: ["down", "enter"] });
  });

  test("the development-channels warning is accepted; an MCP approval is only reported", () => {
    expect(classifyStartupPrompt(CHANNELS)).toEqual({ kind: "development-channels", keys: ["enter"] });
    expect(classifyStartupPrompt(MCP)?.kind).toBe("mcp-approval");
  });

  test("the fullscreen-renderer recovery dialog is answered Not now; a variant with no such option is left blocking, never guessed", () => {
    expect(classifyStartupPrompt(RENDERER)).toEqual({ kind: "fullscreen-renderer", keys: ["down", "enter"] });
    expect(classifyStartupPrompt(RENDERER_AMBIGUOUS)?.kind).toBe("unknown-blocking");
  });

  test("the unrelated 'try the new fullscreen renderer' offer (no 'didn't finish start' text) is not mistaken for the recovery dialog", () => {
    expect(classifyStartupPrompt(RENDERER_OFFER)?.kind).toBe("unknown-blocking");
  });

  test("an unrecognised confirmation is blocking, and an idle screen is no prompt", () => {
    expect(classifyStartupPrompt("Something new?\n❯ 1. Maybe\nEnter to confirm")?.kind).toBe("unknown-blocking");
    expect(classifyStartupPrompt(IDLE_SCREEN)).toBeUndefined();
  });

  test("a menu without a visible cursor yields no keys rather than a guess", () => {
    expect(keysToChoose("1. Yes, I trust this folder\n2. No, exit", /^Yes/)).toBeUndefined();
    expect(keysToChoose("  1. A\n  2. B\n❯ 3. C", /^A/)).toEqual(["up", "up", "enter"]);
  });
});

describe("resident argv", () => {
  test("a fresh resident names its own session; a resume names the old one; channels stay joined to their flag", () => {
    expect(buildResidentClaudeArgs({ ...request, inputs: { mcpNotificationServers: ["rocketr"] } }, "s1")).toEqual([
      "--session-id", "s1", "--permission-mode", "bypassPermissions", "--dangerously-load-development-channels=server:rocketr",
    ]);
    expect(buildResidentClaudeArgs({ ...request, resume: "old", prompt: "hello" }, "unused")).toEqual([
      "--resume", "old", "--permission-mode", "bypassPermissions",
    ]);
  });
});

describe("hostResident", () => {
  test("answers trust then channels, and returns the pane and the session herdr reports", async () => {
    const f = fixture({ screens: [TRUST, CHANNELS] });
    const result = await hostResident(f.client, request, f.options);
    expect(result).toEqual({ ok: true, paneId: "w9:p1", workspaceId: "w9", sessionId: "sess-from-herdr" });
    expect(f.called("agent.sendKeys")).toEqual([{ target: "w9:p1", keys: ["down", "enter"] }, { target: "w9:p1", keys: ["enter"] }]);
    expect(f.called("workspace.create")).toEqual([{ cwd: "/home/agent/project", label: "drovr lead-drovr", focus: false }]);
    expect(f.called("agent.start")[0]).toMatchObject({ kind: "claude", name: "lead-drovr", pane_id: "w9:p1" });
    expect(f.called("workspace.close")).toEqual([]);
  });

  test("the first prompt is submitted only after the startup prompts are answered", async () => {
    const f = fixture({ screens: [TRUST, CHANNELS] });
    expect(await hostResident(f.client, { ...request, prompt: "hello" }, f.options)).toMatchObject({ ok: true });
    expect(f.called("agent.prompt")).toEqual([{ target: "w9:p1", text: "hello" }]);
    const order = f.calls.map((c) => c.method);
    expect(order.indexOf("agent.prompt")).toBeGreaterThan(order.lastIndexOf("agent.sendKeys"));
    expect((f.called("agent.start")[0] as { args: string[] }).args).not.toContain("hello");
  });

  test("a refused first prompt is reported without closing the healthy resident", async () => {
    const f = fixture({ promptError: new Error("busy") });
    expect(await hostResident(f.client, { ...request, prompt: "hello" }, f.options)).toMatchObject({ ok: true, promptError: "busy" });
    expect(f.called("workspace.close")).toEqual([]);
  });

  test("refuses a label another pane already holds, before creating anything", async () => {
    const f = fixture({ agents: [{ pane_id: "w1:p1", workspace_id: "w1", name: "lead-drovr", agent_status: "idle" }] });
    const result = await hostResident(f.client, request, f.options);
    expect(result).toMatchObject({ ok: false, reason: "label-taken", paneId: "w1:p1" });
    expect(f.called("workspace.create")).toEqual([]);
  });

  test("refuses a label herdr would reject as an agent name", async () => {
    const f = fixture();
    for (const label of ["Lead", "a".repeat(33), "has space", ""]) {
      expect(await hostResident(f.client, { ...request, label }, f.options)).toMatchObject({ ok: false, reason: "invalid-label" });
    }
    expect(f.calls).toEqual([]);
  });

  test("only Claude is hosted so far", async () => {
    const f = fixture();
    expect(await hostResident(f.client, { ...request, provider: "codex" }, f.options)).toMatchObject({ ok: false, reason: "unsupported-provider" });
    expect(f.calls).toEqual([]);
  });

  test("an MCP approval prompt closes the workspace and says how to approve at launch", async () => {
    const f = fixture({ screens: [MCP] });
    const result = await hostResident(f.client, request, f.options);
    expect(result).toMatchObject({ ok: false, reason: "blocked-prompt", paneId: "w9:p1" });
    expect(result.ok ? "" : result.detail).toContain("mcpServersApproved");
    expect(f.called("workspace.close")).toEqual([{ workspace_id: "w9" }]);
    expect(f.called("agent.sendKeys")).toEqual([]);
  });

  test("a start failure other than not-ready closes the workspace without polling", async () => {
    const f = fixture({ startError: Object.assign(new Error("boom"), { code: "agent_name_taken" }) });
    expect(await hostResident(f.client, request, f.options)).toMatchObject({ ok: false, reason: "start-failed" });
    expect(f.called("workspace.close")).toEqual([{ workspace_id: "w9" }]);
    expect(f.called("agent.get")).toEqual([]);
  });

  test("a new pane whose shell is still starting is retried, not abandoned", async () => {
    let attempts = 0;
    const f = fixture({ startError: () => ++attempts <= 2 ? HerdrError.from("agent.start", { code: "agent_pane_busy", message: "not an available shell" }) : undefined });
    expect(await hostResident(f.client, request, f.options)).toMatchObject({ ok: true, paneId: "w9:p1" });
    expect(f.called("agent.start")).toHaveLength(3);
    expect(f.called("workspace.close")).toEqual([]);
  });

  test("a start that timed out on readiness keeps going and answers the prompt", async () => {
    const f = fixture({ screens: [TRUST], startError: Object.assign(new Error("not ready"), { code: "agent_not_ready" }) });
    expect(await hostResident(f.client, request, f.options)).toMatchObject({ ok: true, paneId: "w9:p1" });
  });

  test("a resume of a session with no transcript is reported at once, not at the deadline", async () => {
    const f = fixture({ screens: ["$ claude --resume gone\nNo conversation found with session ID: gone\n$"] });
    const result = await hostResident(f.client, { ...request, resume: "gone" }, f.options);
    expect(result).toMatchObject({ ok: false, reason: "no-such-session" });
    expect(f.called("agent.get")).toHaveLength(1);
    expect(f.called("workspace.close")).toEqual([{ workspace_id: "w9" }]);
  });

  test("a resume from a directory other than the conversation's is its own refusal", async () => {
    const f = fixture({ screens: ["$ claude --resume s1\nThis conversation is from a different directory.\n\nTo resume, run:\n  cd /elsewhere && claude --resume s1\n$"] });
    const result = await hostResident(f.client, { ...request, resume: "s1" }, f.options);
    expect(result).toMatchObject({ ok: false, reason: "wrong-directory" });
    expect(f.called("workspace.close")).toEqual([{ workspace_id: "w9" }]);
  });

  test("a pane that never becomes ready is closed at the deadline", async () => {
    const f = fixture({ ready: false });
    expect(await hostResident(f.client, request, f.options)).toMatchObject({ ok: false, reason: "not-ready" });
    expect(f.called("workspace.close")).toEqual([{ workspace_id: "w9" }]);
  });
});

describe("readiness", () => {
  // A scripted herdr: each read returns the next step of the sequence.
  function scripted(steps: { ready: boolean; session?: string; screen: string }[]) {
    let i = 0;
    const keys: string[][] = [];
    const current = () => steps[Math.min(i, steps.length - 1)]!;
    const client = {
      agent: {
        list: async () => ({ type: "agent_list", agents: [] }) as never,
        get: async () => ({ type: "agent_info", agent: {
          pane_id: "w9:p1", workspace_id: "w9", agent_status: "idle", interactive_ready: current().ready,
          ...(current().session ? { agent_session: { kind: "id", value: current().session } } : {}),
        } }) as never,
        read: async () => { const screen = current().screen; i++; return { type: "pane_read", read: { text: screen } } as never; },
        sendKeys: async (p: { keys: string[] }) => { keys.push(p.keys); return { type: "ok" } as never; },
        start: async () => ({ type: "agent_started" }) as never,
        prompt: async () => ({ type: "agent_prompted" }) as never,
      },
      pane: { processInfo: async () => { throw new Error("unused"); }, read: async () => ({ type: "pane_read", read: { text: "" } }) as never },
      workspace: {
        create: async () => ({ type: "workspace_created", root_pane: { pane_id: "w9:p1" }, workspace: { workspace_id: "w9" } }) as never,
        close: async () => ({ type: "ok" }) as never,
        list: async () => ({ type: "workspace_list", workspaces: [] }) as never,
      },
    };
    let time = 0;
    const options = { now: () => time, wait: async (ms: number) => { time += ms; }, mintSessionId: () => "minted", readyTimeoutMs: 30_000, pollIntervalMs: 1_000, startOptions: { now: () => time, wait: async (ms: number) => { time += ms; } } };
    return { client, keys, options, reads: () => i };
  }

  test("ready with no session is not ready: the dev-channels warning drawn next is still answered", async () => {
    // Measured by bakr on lead-dynamic-atmosphere's move (pane wR:p1).
    const f = scripted([
      { ready: true, screen: IDLE_SCREEN },
      { ready: false, screen: CHANNELS },
      { ready: true, session: "sess-1", screen: IDLE_SCREEN },
    ]);
    expect(await hostResident(f.client, request, f.options)).toMatchObject({ ok: true, sessionId: "sess-1" });
    expect(f.keys).toEqual([["enter"]]);
  });

  test("a session herdr never names is accepted after three clean ready reads", async () => {
    const f = scripted([{ ready: true, screen: IDLE_SCREEN }]);
    expect(await hostResident(f.client, request, f.options)).toMatchObject({ ok: true, sessionId: "minted" });
    expect(f.reads()).toBe(3);
  });
});

describe("listResidents and stopResident", () => {
  const agents: Agent[] = [
    { pane_id: "w1:p1", workspace_id: "w1", name: "lead-drovr", agent: "claude", agent_status: "working", cwd: "/a", agent_session: { kind: "id", value: "s1" } },
    { pane_id: "w2:p1", workspace_id: "w2", name: "someone-else", agent: "claude", agent_status: "idle" },
  ];
  const workspaces = [{ workspace_id: "w1", label: "drovr lead-drovr" }, { workspace_id: "w2", label: "bakr other" }];

  test("lists only panes in workspaces Drovr hosts", async () => {
    const f = fixture({ agents, workspaces });
    expect(await listResidents(f.client)).toEqual([
      { paneId: "w1:p1", workspaceId: "w1", label: "lead-drovr", provider: "claude", sessionId: "s1", cwd: "/a", status: "working", pid: 4242 },
    ]);
  });

  test("the pid is the provider's process, never the shell's, and absent when herdr cannot say", async () => {
    const f = fixture({
      agents: [...agents, { pane_id: "w3:p1", workspace_id: "w3", name: "quiet", agent: "claude", agent_status: "idle" }],
      workspaces: [...workspaces, { workspace_id: "w3", label: "drovr quiet" }],
    });
    expect((await listResidents(f.client)).map((r) => [r.paneId, r.pid])).toEqual([["w1:p1", 4242], ["w3:p1", undefined]]);
  });

  test("stops a hosted resident by closing its workspace, and refuses anyone else's pane", async () => {
    const f = fixture({ agents, workspaces });
    expect(await stopResident(f.client, "w1:p1")).toEqual({ ok: true, workspaceId: "w1" });
    expect(await stopResident(f.client, "w2:p1")).toMatchObject({ ok: false, reason: "not-hosted" });
    expect(await stopResident(f.client, "w7:p1")).toMatchObject({ ok: false, reason: "not-found" });
    expect(f.called("workspace.close")).toEqual([{ workspace_id: "w1" }]);
  });
});
