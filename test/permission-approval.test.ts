import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvePermission, autoAnswerPermissions, classifyPermissionPrompt, listPendingPermissions } from "../src/permission-approval.js";

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
});

function fixture(screens: string[], options: { auditFails?: boolean } = {}) {
  const queue = [...screens];
  const keys: string[][] = [];
  const audit: Record<string, unknown>[] = [];
  let clock = 0;
  const client = {
    agent: {
      list: async () => ({ type: "agent_list", agents: [
        { pane_id: "w1:p1", agent: "claude", name: "lead-drovr", agent_status: "blocked", agent_session: { kind: "id", value: "s1" }, cwd: "/a" },
        { pane_id: "w2:p1", agent: "claude", name: "quiet", agent_status: "idle" },
        { pane_id: "w3:p1", agent: "codex", name: "codex", agent_status: "blocked" },
      ] }) as never,
      get: async (target: string) => ({ type: "agent_info", agent: { pane_id: target, name: "lead-drovr", agent_session: { kind: "id", value: "s1" } } }) as never,
      read: async (p: { target: string }) => ({ type: "pane_read", read: { text: p.target === "w1:p1" ? queue[0] ?? AFTER : AFTER } }) as never,
      sendKeys: async (p: { keys: string[] }) => { keys.push(p.keys); queue.shift(); return { type: "ok" } as never; },
    },
  };
  const deps = {
    appendAudit: async (_path: string, line: string) => { if (options.auditFails) throw new Error("disk full"); audit.push(JSON.parse(line)); },
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
});

// Option 2 is not the stored-rule "Yes, and …" option: it's the auto-mode
// option instead, which sits at position 3.
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
    expect(byPane["w2:p1"]).toMatchObject({ outcome: "failed", reason: "unexpected-error" });
    expect((byPane["w2:p1"] as { detail: string }).detail).toMatch(/sendKeys exploded/);
    expect(keysSent["w1:p1"]).toEqual([["down", "enter"]]);
    expect(keysSent["w2:p1"]).toEqual([["down", "enter"]]);
    const audit = await readAudit(path);
    expect(audit.filter((r) => r.paneId === "w1:p1").map((r) => r.outcome)).toEqual(["approving", "approved"]);
    // DROVR-24: a throwing sendKeys leaves this "approving" record with no
    // outcome. This assertion documents the known gap, not the desired
    // behaviour — flip it once DROVR-24 makes approvePermission itself
    // record an outcome on a throw.
    expect(audit.filter((r) => r.paneId === "w2:p1").map((r) => r.outcome)).toEqual(["approving"]);
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
