import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyBlockingScreen, describeUnknownDialog, listBlockingPrompts, scanBlockingPrompts } from "../src/blocking-prompts.js";

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
// AskUserQuestion screens I captured live (2026-09-26) against a real Claude Code pane, by
// starting a claude agent in a fresh herdr pane and prompting it to call AskUserQuestion with
// exact tool input, then reading the pane's raw screen (`herdr agent read <name> --source
// visible`) while it sat blocked on the dialog — see the PR description for the exact steps.
// Plain dialogs turn out to be affected too: nothing here is a reconstruction.
const ASK_USER_QUESTION_PLAIN = [
  "──────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Color",
  "",
  "Which color should the button be?",
  "",
  "❯ 1. Red",
  "     A warm, attention-grabbing red.",
  "  2. Blue",
  "     A cool, calm blue.",
  "  3. Green",
  "     A natural, easy-on-the-eyes green.",
  "  4. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");
// A short, non-truncated preview: one option carries `preview`, so Claude Code switches to the
// side-by-side layout — a boxed preview column right of the option list, and the label of the
// option next to it ("Add nullable column then backfill") wraps onto a second physical line.
const ASK_USER_QUESTION_PREVIEW_SHORT = [
  "──────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Migration",
  "",
  "Which migration approach should we use?",
  "",
  "❯ 1. Add nullable column then     ┌──────────────────────────────────────────────────────────┐",
  "    backfill                      │ ALTER TABLE users ADD COLUMN status text;                │",
  "  2. Add NOT NULL column with     │ UPDATE users SET status = 'active' WHERE status IS NULL; │",
  "    default                       └──────────────────────────────────────────────────────────┘",
  "",
  "                                  Notes: press n to add notes",
  "",
  "──────────────────────────────────────────────────────────────────────────────────────────────",
  "  Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
].join("\n");
// A preview long enough that Claude Code truncates it with a "✂ N lines hidden" marker.
const ASK_USER_QUESTION_PREVIEW_TRUNCATED = [
  "──────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Refactor",
  "",
  "Apply this refactor?",
  "",
  "❯ 1. Apply the refactor           ┌──────────────────────────────────────────┐",
  "  2. Skip for now                 │ line 1                                   │",
  "                                  │ line 2                                   │",
  "                                  │ line 3                                   │",
  "                                  │ line 4                                   │",
  "                                  │ line 5                                   │",
  "                                  │ line 6                                   │",
  "                                  │ line 7                                   │",
  "                                  │ line 8                                   │",
  "                                  │ line 9                                   │",
  "                                  │ line 10                                  │",
  "                                  │ line 11                                  │",
  "                                  │ line 12                                  │",
  "                                  │ line 13                                  │",
  "                                  ├─── ✂ ─── 12 lines hidden ────────────────┤",
  "                                  └──────────────────────────────────────────┘",
  "",
  "                                  Notes: press n to add notes",
  "",
  "──────────────────────────────────────────────────────────────────────────────────────────────",
  "  Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
].join("\n");
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
  test("names the prompts Drovr answers, carries the keys for the ones it can press itself, and marks anything else waiting as unknown", () => {
    expect(classifyBlockingScreen(TRUST)).toMatchObject({ kind: "startup", name: "trust", keys: ["down", "enter"] });
    expect(classifyBlockingScreen(ONBOARDING)).toMatchObject({ kind: "startup", name: "auto-mode-onboarding", keys: ["enter"] });
    expect(classifyBlockingScreen(PERMISSION)).toMatchObject({ kind: "permission", name: "Bash command" });
    expect(classifyBlockingScreen(PERMISSION)).not.toHaveProperty("keys");
    const unknown = classifyBlockingScreen(NEVER_SEEN)!;
    expect(unknown.kind).toBe("unknown");
    expect(unknown.excerpt).toContain("Something Claude Code added last week?");
    expect(unknown.dialog).toEqual({ question: "Something Claude Code added last week?", options: ["Sure", "Later"] });
  });

  test("an MCP approval is a startup prompt Drovr reports, but carries no keys to press", () => {
    const mcp = classifyBlockingScreen("New MCP server found in this project\n❯ 1. Use this and all future MCP servers\n  2. Continue without\nEnter to confirm")!;
    expect(mcp).toMatchObject({ kind: "startup", name: "mcp-approval" });
    expect(mcp).not.toHaveProperty("keys");
  });

  test("a screen waiting on nothing is not reported, even when its transcript quotes a prompt", () => {
    expect(classifyBlockingScreen(IDLE)).toBeUndefined();
    expect(classifyBlockingScreen("")).toBeUndefined();
  });

  test("an AskUserQuestion dialog is unknown with its dialog populated, plain or side-by-side with a preview", () => {
    for (const screen of [ASK_USER_QUESTION_PLAIN, ASK_USER_QUESTION_PREVIEW_SHORT, ASK_USER_QUESTION_PREVIEW_TRUNCATED]) {
      const unknown = classifyBlockingScreen(screen)!;
      expect(unknown.kind).toBe("unknown");
      expect(unknown.dialog).toBeDefined();
    }
  });

  // FACTORY-318/FACTORY-146: a "too-complex" Bash command (real captures, see
  // test/fixtures/too-complex-permission) still classifies as `permission`,
  // not `unknown` — the missing stored-rule option does not defeat
  // recognition — and carries the full parsed prompt so a caller can decide
  // for itself (via `optionFor` from permission-approval.js) whether its own
  // answering scope will actually answer it.
  test("a too-complex Bash dialog with no stored-rule option is still 'permission', with the full prompt attached", () => {
    for (const file of ["brace-with-quote.txt", "zsh-numeric-range-glob.txt"]) {
      const raw = readFileSync(new URL(`./fixtures/too-complex-permission/${file}`, import.meta.url), "utf8");
      const classified = classifyBlockingScreen(raw)!;
      expect(classified.kind).toBe("permission");
      expect(classified.name).toBe("Bash command");
      expect(classified.permission?.options).toEqual(["Yes", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    }
  });

  // FACTORY-365/6: before this fix, the MCP-tool shape read as "unknown"
  // (WAITING_FOOTER matched its own "Esc to cancel" line, but
  // classifyPermissionPrompt failed on the missing rule) and the WebFetch
  // shape read as undefined outright (WAITING_FOOTER matched nothing at
  // all, since its escape hint is inline rather than a footer line) — a
  // WebFetch-blocked pane was invisible to this scan as well as to
  // classifyPermissionPrompt. Both must now be "permission", with the full
  // prompt attached, same as Web Search already is.
  test("the generic MCP-tool, WebFetch and Web Search dialogs are all 'permission', not 'unknown' or undefined (FACTORY-365/6)", () => {
    const cases = [
      { file: "generic-mcp-tool-permission/pane-tell-worker-cropped.txt", tool: "butchr — Tell Worker Tool" },
      { file: "webfetch-permission/pane-fetch-example-com.txt", tool: "Fetch" },
      { file: "websearch-permission/pane-web-search-example-domain-rfc.txt", tool: "Tool use" },
    ];
    for (const { file, tool } of cases) {
      const raw = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
      const classified = classifyBlockingScreen(raw);
      expect(classified?.kind).toBe("permission");
      expect(classified?.name).toBe(tool);
      expect(classified?.permission?.options[0]).toBe("Yes");
    }
  });

  test("a WebFetch-blocked pane classified as undefined before this fix", () => {
    // Documents the regression this closes: before WAITING_FOOTER learned
    // the inline (esc) hint, this screen matched no footer at all, so
    // classifyBlockingScreen returned undefined rather than even "unknown" —
    // invisible to the escalation scan, not merely unanswered.
    const raw = readFileSync(new URL("./fixtures/webfetch-permission/pane-fetch-example-com.txt", import.meta.url), "utf8");
    expect(raw).not.toMatch(/Esc to cancel/);
    expect(classifyBlockingScreen(raw)?.kind).toBe("permission");
  });

  test("a real already-answered MCP-tool screen is still not reported waiting on anything (FACTORY-365/6)", () => {
    const raw = readFileSync(new URL("./fixtures/quoted-permission/pane-mcp-tool-already-answered.txt", import.meta.url), "utf8");
    expect(classifyBlockingScreen(raw)).toBeUndefined();
  });
});

describe("describeUnknownDialog", () => {
  test("reads the question and verbatim options of a numbered or an unnumbered menu", () => {
    expect(describeUnknownDialog(NEVER_SEEN)).toEqual({ question: "Something Claude Code added last week?", options: ["Sure", "Later"] });
    expect(describeUnknownDialog(TRUST)).toEqual({
      question: "Quick safety check: Is this a project you created or one you trust?",
      options: ["No, exit", "Yes, I trust this folder"],
    });
  });

  test("never reads a payload out of a pane merely narrating or quoting a past dialog — the exact loop this exists to close", () => {
    expect(describeUnknownDialog(IDLE)).toBeUndefined();
    // A ticket comment quoting NEVER_SEEN's options back verbatim, with no footer of its own directly beneath it.
    const quoted = "● Escalated as: \"Something Claude Code added last week?\" with options Sure / Later.\n\n$ echo done";
    expect(describeUnknownDialog(quoted)).toBeUndefined();
  });

  test("a menu with two visible cursors, or none, is not read with confidence", () => {
    const twoCursors = "Pick one?\n\n❯ Sure\n❯ Later\n\nEnter to confirm · Esc to cancel";
    const noCursor = "Pick one?\n\n  Sure\n  Later\n\nEnter to confirm · Esc to cancel";
    expect(describeUnknownDialog(twoCursors)).toBeUndefined();
    expect(describeUnknownDialog(noCursor)).toBeUndefined();
  });

  test("a plain AskUserQuestion dialog reads cleanly: verbatim options, no bled-in description, no 'Chat about this' meta-action", () => {
    expect(describeUnknownDialog(ASK_USER_QUESTION_PLAIN)).toEqual({
      question: "Which color should the button be?",
      options: ["Red", "Blue", "Green", "Type something."],
    });
  });

  test("a side-by-side AskUserQuestion dialog with a short preview folds the wrapped label back together and never bleeds the boxed preview text into it", () => {
    expect(describeUnknownDialog(ASK_USER_QUESTION_PREVIEW_SHORT)).toEqual({
      question: "Which migration approach should we use?",
      options: ["Add nullable column then backfill", "Add NOT NULL column with default"],
    });
  });

  test("a side-by-side AskUserQuestion dialog with a truncated ('✂ N lines hidden') preview reads the same way", () => {
    expect(describeUnknownDialog(ASK_USER_QUESTION_PREVIEW_TRUNCATED)).toEqual({
      question: "Apply this refactor?",
      options: ["Apply the refactor", "Skip for now"],
    });
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
      kind: "startup", name: "trust", excerpt: expect.any(String), keys: ["down", "enter"],
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
