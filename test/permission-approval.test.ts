import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvePermission, autoAnswerPermissions, classifyPermissionPrompt, listPendingPermissions, optionFor, scanPendingPermissions } from "../src/permission-approval.js";

const tooComplexFixture = (name: string) => readFileSync(new URL(`./fixtures/too-complex-permission/${name}`, import.meta.url), "utf8");

// Measured on claude 2.1.277 in a herdr pane, 2026-09-18.
const BASH_PROMPT = [
  "❯ Run the shell command touch drovr-permission-probe.txt with the Bash tool. Nothing else.",
  "",
  "● Creating empty probe file",
  "  ⎿  $ touch drovr-permission-probe.txt",
  "",
  "─────────────────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  " Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below",
  "",
  "   touch drovr-permission-probe.txt",
  "   Create empty probe file",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to /tmp/drovr-herdr-proof.hostres from this project",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");
const OTHER_PROMPT = BASH_PROMPT.replaceAll("touch drovr-permission-probe.txt", "rm -rf build");
const AFTER = "● Creating empty probe file\n  ⎿  (No output)\n\n❯ ";

// Measured live on claude 2.1.251 in a herdr pane (DROVR-41 live proof,
// 2026-09-25): option 2's text is long enough to wrap onto a second
// physical line with no number of its own.
const WRAPPED_BASH_PROMPT = [
  "❯ Run the shell command mkdir -p scratch-dir-neg && rm -rf scratch-dir-neg with the Bash",
  "  tool. Nothing else.",
  "",
  "● Bash(mkdir -p scratch-dir-neg && rm -rf scratch-dir-neg)",
  "  ⎿  Waiting…",
  "",
  "──────────────────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  " Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below",
  "",
  "   mkdir -p scratch-dir-neg && rm -rf scratch-dir-neg",
  "   Create and remove scratch-dir-neg",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for mkdir -p scratch-dir-neg and rm -rf scratch-dir-neg",
  "      commands in /tmp/drovr-herdr-proof.41-neg",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

// Synthetic (built from the measured wrap above): the stored-rule option's
// wrapped text now sits at position 3, with the short auto-mode option at
// position 2, so it must still be skipped rather than pressed.
const WRAPPED_RULE_AT_THREE_PROMPT = [
  "❯ Run the shell command mkdir -p scratch-dir-neg && rm -rf scratch-dir-neg with the Bash",
  "  tool. Nothing else.",
  "",
  "● Bash(mkdir -p scratch-dir-neg && rm -rf scratch-dir-neg)",
  "  ⎿  Waiting…",
  "",
  "──────────────────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  " Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below",
  "",
  "   mkdir -p scratch-dir-neg && rm -rf scratch-dir-neg",
  "   Create and remove scratch-dir-neg",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   3. Yes, and don't ask again for mkdir -p scratch-dir-neg and rm -rf scratch-dir-neg",
  "      commands in /tmp/drovr-herdr-proof.41-neg",
  "   4. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

// Synthetic: a non-"Yes, and …" option 2 (the shape measured live on a
// Read-tool dialog outside the project) long enough to wrap.
const WRAPPED_NON_RULE_PROMPT = [
  "❯ Use the Read tool to read the file /etc/an-unusually-long-hostname-file. Nothing else.",
  "",
  "● Read(/etc/an-unusually-long-hostname-file)",
  "",
  "──────────────────────────────────────────────────────────────────────────────────────────────",
  " Read file",
  "",
  "  Read(/etc/an-unusually-long-hostname-file)",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, allow reading from /etc/an-unusually-long-hostname-file",
  "      during this session",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

// Synthetic: the same wrap as WRAPPED_BASH_PROMPT, but the continuation line
// starts at column 0 (unindented) instead of lining up under the option
// text. It must end option collection, not fold into the previous option.
const UNINDENTED_STRAY_LINE_PROMPT = WRAPPED_BASH_PROMPT.replace(
  "      commands in /tmp/drovr-herdr-proof.41-neg",
  "commands in /tmp/drovr-herdr-proof.41-neg",
);

describe("classifyPermissionPrompt", () => {
  test("reads the tool, the request, the options and the cursor off the measured dialog", () => {
    const prompt = classifyPermissionPrompt(BASH_PROMPT)!;
    expect(prompt.tool).toBe("Bash command");
    expect(prompt.request).toBe("touch drovr-permission-probe.txt\nCreate empty probe file");
    expect(prompt.question).toBe("Do you want to proceed?");
    expect(prompt.options).toHaveLength(4);
    expect(prompt.cursor).toBe(0);
    expect(prompt.promptId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("the prompt id names the request, not where the cursor sits", () => {
    const moved = BASH_PROMPT.replace(" ❯ 1. Yes", "   1. Yes").replace("   4. No", " ❯ 4. No");
    expect(classifyPermissionPrompt(moved)!.promptId).toBe(classifyPermissionPrompt(BASH_PROMPT)!.promptId);
    expect(classifyPermissionPrompt(OTHER_PROMPT)!.promptId).not.toBe(classifyPermissionPrompt(BASH_PROMPT)!.promptId);
  });

  test("anything that is not the permission dialog is not one", () => {
    expect(classifyPermissionPrompt(AFTER)).toBeUndefined();
    expect(classifyPermissionPrompt("Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel")).toBeUndefined();
    expect(classifyPermissionPrompt(BASH_PROMPT.replace(" Esc to cancel · Tab to amend", ""))).toBeUndefined();
    expect(classifyPermissionPrompt(BASH_PROMPT.replace("   4. No\n", ""))).toBeUndefined();
  });

  // DROVR-41: a long option wraps onto a following physical line with no
  // number of its own. Before the fix, that continuation line ended the
  // option scan early, the footer check then looked at the wrong window,
  // and the whole dialog read as "not a prompt" — invisible to
  // listPendingPermissions, not merely unanswered.
  test("a wrapped option is folded back into the option it continues", () => {
    const prompt = classifyPermissionPrompt(WRAPPED_BASH_PROMPT)!;
    expect(prompt).toBeDefined();
    expect(prompt.options).toEqual([
      "Yes",
      "Yes, and don't ask again for mkdir -p scratch-dir-neg and rm -rf scratch-dir-neg commands in /tmp/drovr-herdr-proof.41-neg",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "No",
    ]);
    expect(prompt.cursor).toBe(0);
    // The footer must still end the scan, never get folded into the last option.
    expect(prompt.options.some((option) => /Esc to cancel/.test(option))).toBe(false);
    // Stable across two reads of the same wrapped screen: promptId only names the request.
    expect(classifyPermissionPrompt(WRAPPED_BASH_PROMPT)!.promptId).toBe(prompt.promptId);
  });

  test("a blank line still ends the option scan even when earlier options wrapped", () => {
    const prompt = classifyPermissionPrompt(WRAPPED_RULE_AT_THREE_PROMPT)!;
    expect(prompt.options).toHaveLength(4);
    expect(prompt.options[3]).toBe("No");
  });

  test("an unindented stray line ends option collection instead of folding into the previous option", () => {
    // The stray line breaks the scan after only 2 options, so option 4 ("No")
    // is never reached and the dialog fails the "must offer No" check below —
    // proof the line was not silently absorbed into option 2's text.
    expect(classifyPermissionPrompt(UNINDENTED_STRAY_LINE_PROMPT)).toBeUndefined();
  });

  // FACTORY-318/FACTORY-146: Claude's static bash analyser marks a command
  // "too-complex" (a whole family of reasons — brace-with-quote, a zsh
  // <N-M> numeric-range glob, and more, see docs/permission-approval.md) and
  // then never offers a stored-rule option for it at all, leaving the dialog
  // with exactly three options: Yes / switch-to-auto-mode / No. Real
  // captures (claude 2.1.251, `claude --permission-mode default` in an
  // isolated scratch dir, 2026-09-26) — see test/fixtures/too-complex-permission
  // and the PR description for exactly how these two were produced.
  describe("the no-stored-rule 'too-complex' shape (FACTORY-318)", () => {
    const CASES = [
      { file: "brace-with-quote.txt", reason: "Contains brace with quote character (expansion obfuscation)" },
      { file: "zsh-numeric-range-glob.txt", reason: "Contains zsh <N-M> numeric-range glob" },
    ];

    for (const { file, reason } of CASES) {
      test(`${file}: recognised as a permission prompt with exactly 3 options and no stored rule`, () => {
        const prompt = classifyPermissionPrompt(tooComplexFixture(file));
        expect(prompt).toBeDefined();
        expect(prompt!.tool).toBe("Bash command");
        expect(prompt!.request).toContain(reason);
        expect(prompt!.options).toEqual(["Yes", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
      });

      test(`${file}: answerable with option 1 ("Yes") under scope once, and under no scope ever with the auto-mode option`, () => {
        const prompt = classifyPermissionPrompt(tooComplexFixture(file))!;
        expect(optionFor(prompt, "once")).toBe(0);
        expect(prompt.options[optionFor(prompt, "once")]).toBe("Yes");
      });

      test(`${file}: scope always finds no stored-rule option at all — this shape has none to find`, () => {
        const prompt = classifyPermissionPrompt(tooComplexFixture(file))!;
        expect(optionFor(prompt, "always")).toBe(-1);
      });

      test(`${file}: neither scope ever targets the "switch to auto mode" option`, () => {
        const prompt = classifyPermissionPrompt(tooComplexFixture(file))!;
        const autoModeIndex = prompt.options.findIndex((o) => /auto mode/i.test(o));
        expect(autoModeIndex).toBeGreaterThanOrEqual(0); // sanity: it really is on this dialog
        expect(optionFor(prompt, "once")).not.toBe(autoModeIndex);
        expect(optionFor(prompt, "always")).not.toBe(autoModeIndex);
      });
    }
  });

  // FACTORY-365/6: the generic MCP-tool dialog and WebFetch each fail exactly
  // one of classifyPermissionPrompt's preconditions, and a different one
  // each — see docs/permission-approval.md for the full captured screens and
  // exactly how they were captured.
  describe("the generic MCP-tool dialog (FACTORY-365/6): no ─ rule anywhere on screen", () => {
    // Real capture, claude 2.1.251, `claude --permission-mode default
    // --restricted` in an isolated scratch pane (herdr `pane run` + `pane
    // read --source visible`), 2026-09-27: the butchr MCP tool tell_worker
    // was called with a long enough `text` parameter that its own header
    // ("Tool use" / the tool-call params / the ─ rule above them) scrolled
    // off the *visible* screen — the exact read drovr itself uses
    // (`source: "visible"` in `readScreen`). What remains above the question
    // is only the dialog's own "About the … Tool:" frame, with no rule at
    // all — this is the shape a real blocked pane's visible screen shows
    // whenever the call's displayed request is long enough, not a shape
    // specific to Tell Worker.
    const mcpToolFixture = readFileSync(new URL("./fixtures/generic-mcp-tool-permission/pane-tell-worker-cropped.txt", import.meta.url), "utf8");

    test("recognised from its own frame, with no ─ rule anywhere on screen", () => {
      expect(mcpToolFixture).not.toMatch(/─{10,}/);
      const prompt = classifyPermissionPrompt(mcpToolFixture);
      expect(prompt).toBeDefined();
      expect(prompt!.tool).toBe("butchr — Tell Worker Tool");
      expect(prompt!.options).toEqual([
        "Yes",
        "Yes, and don't ask again for butchr — Tell Worker commands in /tmp/claude-1002/…",
        "No",
      ]);
    });

    test("answerable with option 1 (\"Yes\") under scope once", () => {
      const prompt = classifyPermissionPrompt(mcpToolFixture)!;
      expect(optionFor(prompt, "once")).toBe(0);
      expect(prompt.options[optionFor(prompt, "once")]).toBe("Yes");
    });
  });

  describe("the WebFetch dialog (FACTORY-365/6): no Esc to cancel footer at all", () => {
    // Real capture, claude 2.1.251, `claude --permission-mode default` in an
    // isolated scratch pane, prompted "Use the WebFetch tool on
    // https://example.com and tell me the page title. Nothing else.", read
    // with `herdr pane read --source recent --lines 60` (also verified not a
    // viewport-truncation artefact against a 60-line window), 2026-09-27.
    const webfetchFixture = readFileSync(new URL("./fixtures/webfetch-permission/pane-fetch-example-com.txt", import.meta.url), "utf8");

    test("recognised from the inline (esc) hint on its No option, with no Esc to cancel line anywhere", () => {
      expect(webfetchFixture).not.toMatch(/Esc to cancel/);
      const prompt = classifyPermissionPrompt(webfetchFixture);
      expect(prompt).toBeDefined();
      expect(prompt!.tool).toBe("Fetch");
      expect(prompt!.options).toEqual([
        "Yes",
        "Yes, and don't ask again for example.com",
        "No, and tell Claude what to do differently (esc)",
      ]);
    });

    test("answerable with option 1 (\"Yes\") under scope once", () => {
      const prompt = classifyPermissionPrompt(webfetchFixture)!;
      expect(optionFor(prompt, "once")).toBe(0);
      expect(prompt.options[optionFor(prompt, "once")]).toBe("Yes");
    });
  });

  // Positive control (FACTORY-356 comment 26459): Web Search already has
  // both the rule and the footer, and stays recognised unchanged by the two
  // relaxations above. Not incidental — an explicit regression guard.
  describe("Web Search stays recognised (regression guard, FACTORY-365/6)", () => {
    // Real capture, claude 2.1.251, same scratch session as the WebFetch
    // capture above, prompted 'Use the WebSearch tool to search for "example
    // domain rfc". Nothing else.', 2026-09-27.
    const webSearchFixture = readFileSync(new URL("./fixtures/websearch-permission/pane-web-search-example-domain-rfc.txt", import.meta.url), "utf8");

    test("recognised, with option 1 (\"Yes\") answerable under scope once", () => {
      const prompt = classifyPermissionPrompt(webSearchFixture);
      expect(prompt).toBeDefined();
      expect(prompt!.tool).toBe("Tool use");
      expect(optionFor(prompt!, "once")).toBe(0);
      expect(prompt!.options[0]).toBe("Yes");
    });
  });

  // FACTORY-365/6: both gates relaxed above exist to stop a dialog that is
  // merely QUOTED in scrollback — never live — from being pressed. Proving
  // that hole is not open, for the specific shape the MCP-tool relaxation
  // touches.
  describe("a quoted or already-answered MCP-tool dialog is never recognised (FACTORY-365/6)", () => {
    test("a real screen where the dialog was already answered classifies as undefined", () => {
      // Real capture, same scratch session as the MCP-tool fixture above:
      // after pressing "1" on the tell_worker dialog and letting the call
      // finish, the dialog itself is gone from the screen entirely (Claude
      // Code clears it on selection) — there is no "Do you want to
      // proceed?" line left to match at all.
      const answered = readFileSync(new URL("./fixtures/quoted-permission/pane-mcp-tool-already-answered.txt", import.meta.url), "utf8");
      expect(answered).not.toMatch(/Do you want to proceed\?/);
      expect(classifyPermissionPrompt(answered)).toBeUndefined();
    });

    test("synthetic: the expand hint narrated in prose, with no About the … Tool: frame directly above it, is not recognised", () => {
      // Synthetic (labelled): the MCP-tool relaxation requires BOTH `About
      // the … Tool:` and `(ctrl+o to expand description)` in an unbroken,
      // directly-adjacent run above the question — never either alone. A
      // screen that merely mentions the expand hint in ordinary assistant
      // narration, without the real frame's header line immediately above
      // it, must still fail to classify as a permission prompt.
      const narrated = readFileSync(new URL("./fixtures/quoted-permission/synthetic-mcp-tool-narrated-not-framed.txt", import.meta.url), "utf8");
      expect(narrated).toMatch(/ctrl\+o to expand description/);
      expect(narrated).not.toMatch(/About the .+:/);
      expect(classifyPermissionPrompt(narrated)).toBeUndefined();
    });
  });
});

function fixture(screens: string[], options: { auditFails?: boolean | number; throwOnSendKeys?: boolean } = {}) {
  const queue = [...screens];
  const keys: string[][] = [];
  const audit: Record<string, unknown>[] = [];
  let clock = 0;
  let auditCalls = 0;
  const client = {
    agent: {
      list: async () => ({ type: "agent_list", agents: [
        { pane_id: "w1:p1", agent: "claude", name: "lead-drovr", agent_status: "blocked", agent_session: { kind: "id", value: "s1" }, cwd: "/a" },
        { pane_id: "w2:p1", agent: "claude", name: "quiet", agent_status: "idle" },
        { pane_id: "w3:p1", agent: "codex", name: "codex", agent_status: "blocked" },
      ] }) as never,
      get: async (target: string) => ({ type: "agent_info", agent: { pane_id: target, name: "lead-drovr", agent_session: { kind: "id", value: "s1" } } }) as never,
      read: async (p: { target: string }) => ({ type: "pane_read", read: { text: p.target === "w1:p1" ? queue[0] ?? AFTER : AFTER } }) as never,
      sendKeys: async (p: { keys: string[] }) => {
        keys.push(p.keys);
        if (options.throwOnSendKeys) throw new Error("sendKeys exploded");
        queue.shift();
        return { type: "ok" } as never;
      },
    },
  };
  const deps = {
    appendAudit: async (_path: string, line: string) => {
      auditCalls++;
      const fails = options.auditFails === true || (typeof options.auditFails === "number" && auditCalls > options.auditFails);
      if (fails) throw new Error("disk full");
      audit.push(JSON.parse(line));
    },
    now: () => new Date(Date.UTC(2026, 8, 18) + clock),
    wait: async (ms: number) => { clock += ms; },
    verifyTimeoutMs: 1_000,
    pollMs: 250,
  };
  return { client, keys, audit, deps };
}

const idOf = (screen: string) => classifyPermissionPrompt(screen)!.promptId;
const base = { paneId: "w1:p1", operator: "brooswit", auditPath: "/audit.jsonl" };

describe("listPendingPermissions", () => {
  test("reads every Claude pane's screen and returns only those showing the dialog", async () => {
    const f = fixture([BASH_PROMPT]);
    const pending = await listPendingPermissions(f.client);
    expect(pending.map((p) => [p.paneId, p.label, p.sessionId, p.tool])).toEqual([["w1:p1", "lead-drovr", "s1", "Bash command"]]);
  });
});

describe("scanPendingPermissions", () => {
  test("an unreadable pane is reported, never silently treated as 'no pending prompt'; a hung read is bounded by readTimeoutMs, not left open", async () => {
    let hungReadWasCalled = false;
    const client = {
      agent: {
        list: async () => ({ type: "agent_list", agents: [
          { pane_id: "w1:p1", agent: "claude", name: "fine", agent_status: "blocked", agent_session: { kind: "id", value: "s1" }, cwd: "/a" },
          { pane_id: "w2:p1", agent: "claude", name: "broken", agent_status: "idle" },
          { pane_id: "w3:p1", agent: "claude", name: "hung", agent_status: "idle" },
        ] }) as never,
        get: async (target: string) => ({ type: "agent_info", agent: { pane_id: target } }) as never,
        read: async (p: { target: string }) => {
          if (p.target === "w1:p1") return { type: "pane_read", read: { text: BASH_PROMPT } } as never;
          if (p.target === "w2:p1") throw new Error("gone");
          hungReadWasCalled = true;
          // Simulates a wedged `agent.read` that never settles.
          return new Promise<never>(() => undefined);
        },
        sendKeys: async () => { throw new Error("not used in this test"); },
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
    const result = await scanPendingPermissions(client, { readTimeoutMs: 1500, readWait: () => flush() });
    expect(hungReadWasCalled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(result.pending).toEqual([{ ...classifyPermissionPrompt(BASH_PROMPT)!, paneId: "w1:p1", label: "fine", sessionId: "s1", cwd: "/a" }]);
    expect(result.unreadable).toHaveLength(2);
    const byPane = Object.fromEntries(result.unreadable.map((u) => [u.paneId, u]));
    expect(byPane["w2:p1"]).toMatchObject({ label: "broken", herdrStatus: "idle", reason: "error", detail: "gone" });
    expect(byPane["w3:p1"]).toMatchObject({ label: "hung", herdrStatus: "idle", reason: "timeout" });
    expect((byPane["w3:p1"] as { detail: string }).detail).toContain("1500");
  });

  test("a failure of agent.list() itself still rejects — the caller maps that to 'couldn't check anything'", async () => {
    const client = {
      agent: {
        list: async () => { throw new Error("herdr socket gone"); },
        get: async () => { throw new Error("unused"); },
        read: async () => { throw new Error("unused"); },
        sendKeys: async () => { throw new Error("unused"); },
      },
    };
    await expect(scanPendingPermissions(client)).rejects.toThrow("herdr socket gone");
  });
});

describe("approvePermission", () => {
  test("answers Yes once, verifies the prompt cleared, and audits before and after", async () => {
    const f = fixture([BASH_PROMPT]);
    const result = await approvePermission(f.client, { ...base, promptId: idOf(BASH_PROMPT) }, f.deps);
    expect(result).toMatchObject({ ok: true, tool: "Bash command", scope: "once" });
    expect(f.keys).toEqual([["enter"]]);
    expect(f.audit.map((r) => r.outcome)).toEqual(["approving", "approved"]);
    expect(f.audit[0]).toMatchObject({ operator: "brooswit", paneId: "w1:p1", label: "lead-drovr", sessionId: "s1", tool: "Bash command", option: "Yes", scope: "once" });
  });

  test("always picks the stored-rule option, never the one that switches to auto mode", async () => {
    const f = fixture([BASH_PROMPT]);
    await approvePermission(f.client, { ...base, promptId: idOf(BASH_PROMPT), scope: "always" }, f.deps);
    expect(f.keys).toEqual([["down", "enter"]]);
    expect(f.audit[0]!.option).toMatch(/^Yes, and always allow access/);
  });

  test("a different prompt than the operator saw is refused and nothing is pressed", async () => {
    const f = fixture([OTHER_PROMPT]);
    const result = await approvePermission(f.client, { ...base, promptId: idOf(BASH_PROMPT) }, f.deps);
    expect(result).toMatchObject({ ok: false, reason: "prompt-changed" });
    expect(f.keys).toEqual([]);
    expect(f.audit).toMatchObject([{ outcome: "prompt-changed", request: "rm -rf build\nCreate empty probe file" }]);
  });

  test("no prompt, or no operator, is refused and recorded", async () => {
    const f = fixture([]);
    expect(await approvePermission(f.client, { ...base, promptId: "x" }, f.deps)).toMatchObject({ ok: false, reason: "no-prompt" });
    expect(await approvePermission(f.client, { ...base, operator: " ", promptId: "x" }, f.deps)).toMatchObject({ ok: false, reason: "invalid-operator" });
    expect(f.keys).toEqual([]);
    expect(f.audit.map((r) => r.outcome)).toEqual(["no-prompt", "invalid-operator"]);
  });

  test("an audit that cannot be written means nothing is pressed", async () => {
    const f = fixture([BASH_PROMPT], { auditFails: true });
    expect(await approvePermission(f.client, { ...base, promptId: idOf(BASH_PROMPT) }, f.deps)).toMatchObject({ ok: false, reason: "audit-failed" });
    expect(f.keys).toEqual([]);
  });

  test("keys that leave the same prompt on screen are reported, not claimed", async () => {
    const f = fixture([BASH_PROMPT, BASH_PROMPT]);
    const result = await approvePermission(f.client, { ...base, promptId: idOf(BASH_PROMPT) }, f.deps);
    expect(result).toMatchObject({ ok: false, reason: "not-cleared" });
    expect(f.audit.map((r) => r.outcome)).toEqual(["approving", "not-cleared"]);
  });

  // DROVR-24: a throwing sendKeys used to escape approvePermission entirely,
  // leaving the "approving" record stranded with no outcome. It must not
  // throw, must record an outcome, and must never retry the keys.
  test("a throwing sendKeys never escapes: ok:false keys-failed, audit holds approving then keys-failed, sendKeys called once", async () => {
    const f = fixture([BASH_PROMPT], { throwOnSendKeys: true });
    const result = await approvePermission(f.client, { ...base, promptId: idOf(BASH_PROMPT) }, f.deps);
    expect(result).toMatchObject({ ok: false, reason: "keys-failed" });
    expect((result as { detail: string }).detail).toMatch(/whether a key may have reached the pane is unknown/);
    expect((result as { detail: string }).detail).toMatch(/sendKeys exploded/);
    expect(f.keys).toHaveLength(1);
    expect(f.audit.map((r) => r.outcome)).toEqual(["approving", "keys-failed"]);
    const attemptIds = new Set(f.audit.map((r) => r.attemptId));
    expect(attemptIds.size).toBe(1);
    expect([...attemptIds][0]).toBe((result as { attemptId: string }).attemptId);
  });

  // DROVR-24 acceptance: the outcome-audit write failing must not mask the result.
  test("a throwing sendKeys whose outcome-audit write also throws still returns ok:false keys-failed", async () => {
    const f = fixture([BASH_PROMPT], { throwOnSendKeys: true, auditFails: 1 }); // the "approving" write (call 1) succeeds; the outcome write (call 2) fails
    const result = await approvePermission(f.client, { ...base, promptId: idOf(BASH_PROMPT) }, f.deps);
    expect(result).toMatchObject({ ok: false, reason: "keys-failed" });
    expect(f.keys).toHaveLength(1);
    expect(f.audit.map((r) => r.outcome)).toEqual(["approving"]); // the outcome write failed, but the result is still returned
  });

  // DROVR-24: an unexpected throw inside the verify loop (deps.now/deps.wait)
  // is treated the same way, under the distinct reason verify-failed, since
  // by then sendKeys already resolved.
  test("a throwing wait inside the verify loop never escapes: ok:false verify-failed, audit holds approving then verify-failed", async () => {
    const f = fixture([BASH_PROMPT, BASH_PROMPT]); // still shows the prompt after sendKeys, so the loop reaches deps.wait
    const deps = { ...f.deps, wait: async () => { throw new Error("wait exploded"); } };
    const result = await approvePermission(f.client, { ...base, promptId: idOf(BASH_PROMPT) }, deps);
    expect(result).toMatchObject({ ok: false, reason: "verify-failed" });
    expect((result as { detail: string }).detail).toMatch(/wait exploded/);
    expect(f.keys).toHaveLength(1);
    expect(f.audit.map((r) => r.outcome)).toEqual(["approving", "verify-failed"]);
  });
});

// Option 2 is not the stored-rule "Yes, and …" option: it's the auto-mode
// option instead, which sits at position 3.
// Claude's read-permission dialog as seen live on codey (FACTORY-93,
// 2026-09-26): its stored-rule option says "Yes, allow reading …", with no
// "and", so the "always" matcher never recognises it.
const READ_PROMPT = BASH_PROMPT
  .replace(" 2. Yes, and always allow access to /tmp/drovr-herdr-proof.hostres from this project", " 2. Yes, allow reading from /home/brooswit/Projects/rocketchat from this project");

const NO_RULE_AT_TWO_PROMPT = BASH_PROMPT
  .replace(" 2. Yes, and always allow access to /tmp/drovr-herdr-proof.hostres from this project", " 2. Yes, and switch to auto mode · auto mode handles these prompts for you")
  .replace(" 3. Yes, and switch to auto mode · auto mode handles these prompts for you", " 3. Yes, and always allow access to /tmp/drovr-herdr-proof.hostres from this project");

describe("autoAnswerPermissions", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  async function freshAuditPath(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "drovr-auto-answer-"));
    return join(dir, "audit.jsonl");
  }

  async function readAudit(path: string): Promise<Record<string, unknown>[]> {
    const text = await readFile(path, "utf8").catch(() => "");
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  }

  function autoClient(panes: Record<string, { reads: string[]; throwOnSendKeys?: boolean; hangAfterReads?: number }>) {
    const keysSent: Record<string, string[][]> = {};
    const readCounts: Record<string, number> = {};
    const client = {
      agent: {
        list: async () => ({
          type: "agent_list",
          agents: Object.keys(panes).map((paneId) => ({ pane_id: paneId, agent: "claude", name: paneId, agent_status: "blocked" })),
        }) as never,
        get: async (target: string) => ({ type: "agent_info", agent: { pane_id: target, name: target } }) as never,
        read: async (p: { target: string }) => {
          const script = panes[p.target];
          const count = (readCounts[p.target] = (readCounts[p.target] ?? 0) + 1);
          // Simulates a pane approvePermission can never finish reading, e.g. a
          // wedged terminal: the read call itself never settles.
          if (script?.hangAfterReads !== undefined && count > script.hangAfterReads) return new Promise<never>(() => undefined);
          const text = script && script.reads.length > 0 ? script.reads.shift()! : AFTER;
          return { type: "pane_read", read: { text } } as never;
        },
        sendKeys: async (p: { target: string; keys: string[] }) => {
          (keysSent[p.target] ??= []).push(p.keys);
          if (panes[p.target]?.throwOnSendKeys) throw new Error("sendKeys exploded");
          return { type: "ok" } as never;
        },
      },
    };
    return { client, keysSent };
  }

  test("an option-2 'Yes, and …' prompt is answered exactly once, scope always, audited as drovr-auto", async () => {
    const path = await freshAuditPath();
    const { client, keysSent } = autoClient({ "w1:p1": { reads: [BASH_PROMPT, BASH_PROMPT, AFTER] } });
    const results = await autoAnswerPermissions(client, { auditPath: path });
    expect(results).toEqual([{ paneId: "w1:p1", label: "w1:p1", outcome: "answered", tool: "Bash command", request: "touch drovr-permission-probe.txt\nCreate empty probe file" }]);
    expect(keysSent["w1:p1"]).toEqual([["down", "enter"]]);
    const audit = await readAudit(path);
    expect(audit.map((r) => r.outcome)).toEqual(["approving", "approved"]);
    expect(audit[0]).toMatchObject({ operator: "drovr-auto", scope: "always", option: "Yes, and always allow access to /tmp/drovr-herdr-proof.hostres from this project" });
  });

  test("a prompt whose option 2 is not 'Yes, and …' is skipped with nothing pressed", async () => {
    const path = await freshAuditPath();
    const { client, keysSent } = autoClient({ "w1:p1": { reads: [NO_RULE_AT_TWO_PROMPT] } });
    const results = await autoAnswerPermissions(client, { auditPath: path });
    expect(results).toMatchObject([{ paneId: "w1:p1", outcome: "skipped" }]);
    expect((results[0] as { reason: string }).reason).toMatch(/not option 2/);
    expect(keysSent["w1:p1"]).toBeUndefined();
    expect(await readAudit(path)).toEqual([]);
  });

  test("scope once presses option 1 'Yes' with no key movement, audited as scope once", async () => {
    const path = await freshAuditPath();
    const { client, keysSent } = autoClient({ "w1:p1": { reads: [BASH_PROMPT, BASH_PROMPT, AFTER] } });
    const results = await autoAnswerPermissions(client, { auditPath: path, scope: "once" });
    expect(results).toMatchObject([{ paneId: "w1:p1", outcome: "answered", tool: "Bash command" }]);
    expect(keysSent["w1:p1"]).toEqual([["enter"]]);
    const audit = await readAudit(path);
    expect(audit.map((r) => r.outcome)).toEqual(["approving", "approved"]);
    expect(audit[0]).toMatchObject({ operator: "drovr-auto", scope: "once", option: "Yes" });
  });

  test("scope once answers the read-permission dialog that scope always skips (FACTORY-93)", async () => {
    const path = await freshAuditPath();
    const always = autoClient({ "w1:p1": { reads: [READ_PROMPT] } });
    const skipped = await autoAnswerPermissions(always.client, { auditPath: path });
    expect(skipped).toMatchObject([{ paneId: "w1:p1", outcome: "skipped" }]);
    expect(always.keysSent["w1:p1"]).toBeUndefined();
    const once = autoClient({ "w1:p1": { reads: [READ_PROMPT, READ_PROMPT, AFTER] } });
    const answered = await autoAnswerPermissions(once.client, { auditPath: path, scope: "once" });
    expect(answered).toMatchObject([{ paneId: "w1:p1", outcome: "answered" }]);
    expect(once.keysSent["w1:p1"]).toEqual([["enter"]]);
  });

  test("scope once skips a prompt whose option 1 is not plain 'Yes', nothing pressed", async () => {
    const path = await freshAuditPath();
    const odd = BASH_PROMPT.replace(" ❯ 1. Yes", " ❯ 1. No").replace("   4. No", "   4. Yes");
    const { client, keysSent } = autoClient({ "w1:p1": { reads: [odd] } });
    const results = await autoAnswerPermissions(client, { auditPath: path, scope: "once" });
    // Either not classified as a permission prompt at all, or classified and
    // skipped — never answered, never pressed, never audited.
    expect(results.filter((r) => r.outcome === "answered")).toEqual([]);
    for (const r of results) expect(r.outcome).toBe("skipped");
    expect(keysSent["w1:p1"]).toBeUndefined();
    expect(await readAudit(path)).toEqual([]);
  });

  test("a prompt that changed between scan and press is refused, nothing pressed", async () => {
    const path = await freshAuditPath();
    const { client, keysSent } = autoClient({ "w1:p1": { reads: [BASH_PROMPT, OTHER_PROMPT] } });
    const results = await autoAnswerPermissions(client, { auditPath: path });
    expect(results).toMatchObject([{ paneId: "w1:p1", outcome: "skipped" }]);
    expect((results[0] as { reason: string }).reason).toMatch(/different prompt/);
    expect(keysSent["w1:p1"]).toBeUndefined();
    const audit = await readAudit(path);
    expect(audit.map((r) => r.outcome)).toEqual(["prompt-changed"]);
  });

  test("one pane throwing does not stop another pane from being answered", async () => {
    const path = await freshAuditPath();
    const { client, keysSent } = autoClient({
      "w1:p1": { reads: [BASH_PROMPT, BASH_PROMPT, AFTER] },
      "w2:p1": { reads: [BASH_PROMPT, BASH_PROMPT], throwOnSendKeys: true },
    });
    const results = await autoAnswerPermissions(client, { auditPath: path });
    const byPane = Object.fromEntries(results.map((r) => [r.paneId, r]));
    expect(byPane["w1:p1"]).toMatchObject({ outcome: "answered", tool: "Bash command" });
    // DROVR-24 fix: approvePermission itself now catches a throwing sendKeys
    // and returns ok:false reason:"keys-failed" instead of rejecting, so this
    // pane's own outer try/catch in autoAnswerPermissions is no longer what
    // reports it — it comes back through the same result-mapping path as
    // not-cleared/audit-failed, not as "unexpected-error".
    expect(byPane["w2:p1"]).toMatchObject({ outcome: "failed", reason: "keys-failed" });
    expect((byPane["w2:p1"] as { detail: string }).detail).toMatch(/sendKeys exploded/);
    expect(keysSent["w1:p1"]).toEqual([["down", "enter"]]);
    expect(keysSent["w2:p1"]).toEqual([["down", "enter"]]);
    const audit = await readAudit(path);
    expect(audit.filter((r) => r.paneId === "w1:p1").map((r) => r.outcome)).toEqual(["approving", "approved"]);
    // Previously this "approving" record was left stranded with no outcome
    // line (the known DROVR-24 gap); approvePermission now writes a
    // best-effort keys-failed outcome for the same attemptId before
    // returning.
    expect(audit.filter((r) => r.paneId === "w2:p1").map((r) => r.outcome)).toEqual(["approving", "keys-failed"]);
  });

  test("a pane whose approve attempt hangs past readTimeoutMs is failed, without blocking another pane's answer", async () => {
    const path = await freshAuditPath();
    const { client, keysSent } = autoClient({
      "w1:p1": { reads: [BASH_PROMPT, BASH_PROMPT, AFTER] },
      "w2:p1": { reads: [BASH_PROMPT], hangAfterReads: 1 }, // scan succeeds; approvePermission's own re-read never resolves
    });
    const results = await autoAnswerPermissions(client, { auditPath: path, readTimeoutMs: 20 });
    const byPane = Object.fromEntries(results.map((r) => [r.paneId, r]));
    expect(byPane["w1:p1"]).toMatchObject({ outcome: "answered", tool: "Bash command" });
    expect(byPane["w2:p1"]).toMatchObject({ outcome: "failed", reason: "timeout" });
    expect((byPane["w2:p1"] as { detail: string }).detail).toMatch(/outcome is unknown/);
    expect(keysSent["w1:p1"]).toEqual([["down", "enter"]]);
    expect(keysSent["w2:p1"]).toBeUndefined();
  });

  // DROVR-41: regression coverage for the wrap fix, built from the raw
  // screen measured live on claude 2.1.251 in the DROVR-41 proof session.
  test("a wrapped option-2 'Yes, and …' prompt is answered exactly once, scope always, audited as drovr-auto", async () => {
    const path = await freshAuditPath();
    const { client, keysSent } = autoClient({ "w1:p1": { reads: [WRAPPED_BASH_PROMPT, WRAPPED_BASH_PROMPT, AFTER] } });
    const results = await autoAnswerPermissions(client, { auditPath: path });
    expect(results).toEqual([{ paneId: "w1:p1", label: "w1:p1", outcome: "answered", tool: "Bash command", request: "mkdir -p scratch-dir-neg && rm -rf scratch-dir-neg\nCreate and remove scratch-dir-neg" }]);
    expect(keysSent["w1:p1"]).toEqual([["down", "enter"]]);
    const audit = await readAudit(path);
    expect(audit.map((r) => r.outcome)).toEqual(["approving", "approved"]);
    expect(audit[0]).toMatchObject({ operator: "drovr-auto", scope: "always", option: "Yes, and don't ask again for mkdir -p scratch-dir-neg and rm -rf scratch-dir-neg commands in /tmp/drovr-herdr-proof.41-neg" });
  });

  test("a wrapped stored-rule option sitting at position 3 (auto-mode at 2) is still skipped, nothing pressed", async () => {
    const path = await freshAuditPath();
    const { client, keysSent } = autoClient({ "w1:p1": { reads: [WRAPPED_RULE_AT_THREE_PROMPT] } });
    const results = await autoAnswerPermissions(client, { auditPath: path });
    expect(results).toMatchObject([{ paneId: "w1:p1", outcome: "skipped" }]);
    expect((results[0] as { reason: string }).reason).toMatch(/not option 2/);
    expect(keysSent["w1:p1"]).toBeUndefined();
    expect(await readAudit(path)).toEqual([]);
  });

  test("a wrapped non-'Yes, and …' option 2 is still skipped, nothing pressed", async () => {
    const path = await freshAuditPath();
    const { client, keysSent } = autoClient({ "w1:p1": { reads: [WRAPPED_NON_RULE_PROMPT] } });
    const results = await autoAnswerPermissions(client, { auditPath: path });
    expect(results).toMatchObject([{ paneId: "w1:p1", outcome: "skipped" }]);
    expect((results[0] as { reason: string }).reason).toMatch(/no "Yes, and …" stored-rule option/);
    expect(keysSent["w1:p1"]).toBeUndefined();
    expect(await readAudit(path)).toEqual([]);
  });
});
