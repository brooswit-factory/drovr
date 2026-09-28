import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveCodexApproval,
  autoAnswerCodexApprovals,
  classifyCodexApprovalScreen,
  onceOptionIndex,
  scanPendingCodexApprovals,
  type CodexPermissionPrompt,
} from "../src/codex-permission-approval.js";

// Verbatim herdr reads of codex-cli 0.145.0 in a herdr pane (2026-09-26), one
// dedicated `drovr-codex-probe` session, never a shared/live one. See
// docs/codex-permission-approval.md for the full wording table.
const fixture = (name: string) => readFile(new URL(`./fixtures/codex-approval/${name}`, import.meta.url), "utf8");

// A plain composer screen: no dialog, nothing approval-shaped on it.
const NO_PROMPT = [
  "╭───────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.145.0)                │",
  "╰───────────────────────────────────────────╯",
  "",
  "• Ran touch drovr-codex-probe.txt",
  "  └ (no output)",
  "",
  "› Run /review on my current changes",
  "",
  "  gpt-5.6-sol default · /tmp/drovr-codex-probe",
].join("\n");

describe("classifyCodexApprovalScreen", () => {
  test("a command-execution dialog (writing outside cwd)", async () => {
    const prompt = classifyCodexApprovalScreen(await fixture("pane-command-outside-cwd.txt")) as CodexPermissionPrompt;
    expect(prompt.kind).toBe("command");
    expect(prompt.detail).toBe("Allow creating drovr-codex-probe-home.txt in your home directory? — $ touch ~/drovr-codex-probe-home.txt");
    expect(prompt.options).toEqual([
      "Yes, proceed (y)",
      "Yes, and don't ask again for commands that start with `touch '~/drovr-codex-probe- home.txt'` (p)",
      "No, and tell Codex what to do differently (esc)",
    ]);
    expect(prompt.cursor).toBe(0);
    expect(prompt.promptId).toMatch(/^[0-9a-f]{16}$/);
  });

  // Codex has no separate on-screen dialog for network access: it is the
  // SAME "run a command" shape, differing only in the Reason: text.
  test("a network-access escalation renders the identical 'command' shape", async () => {
    const prompt = classifyCodexApprovalScreen(await fixture("pane-command-network.txt")) as CodexPermissionPrompt;
    expect(prompt.kind).toBe("command");
    expect(prompt.detail).toContain("Allow network access to download example.com");
    expect(prompt.options[0]).toBe("Yes, proceed (y)");
  });

  test("a file-edit/patch dialog names the diff summary, not the whole preceding turn", async () => {
    const prompt = classifyCodexApprovalScreen(await fixture("pane-file-edit.txt")) as CodexPermissionPrompt;
    expect(prompt.kind).toBe("file-edit");
    expect(prompt.detail).toBe("• Added ~/drovr-codex-probe-edit.txt (+1 -0) 1 +hello from codex edit");
    expect(prompt.options).toEqual([
      "Yes, proceed (y)",
      "Yes, and don't ask again for these files (a)",
      "No, and tell Codex what to do differently (esc)",
    ]);
  });

  test("an MCP tool-call dialog names the server and tool, options include the inline description", async () => {
    const prompt = classifyCodexApprovalScreen(await fixture("pane-mcp-tool.txt")) as CodexPermissionPrompt;
    expect(prompt.kind).toBe("mcp-tool");
    expect(prompt.detail).toBe("drovrprobe.danger_tool");
    expect(prompt.options).toEqual([
      "Allow                   Run the tool and continue.",
      "Allow for this session  Run the tool and remember this choice for this session.",
      "Always allow            Run the tool and remember this choice for future tool calls.",
      "Cancel                  Cancel this tool call",
    ]);
    expect(prompt.cursor).toBe(0);
  });

  test("an ordinary composer screen is not a prompt at all", () => {
    expect(classifyCodexApprovalScreen(NO_PROMPT)).toBeUndefined();
    expect(classifyCodexApprovalScreen("")).toBeUndefined();
  });

  test("the prompt id names the request, not where the cursor sits", async () => {
    const raw = await fixture("pane-command-outside-cwd.txt");
    const moved = raw.replace("› 1. Yes, proceed (y)", "  1. Yes, proceed (y)").replace(
      "3. No, and tell Codex what to do differently (esc)",
      "› 3. No, and tell Codex what to do differently (esc)",
    );
    const a = classifyCodexApprovalScreen(raw) as CodexPermissionPrompt;
    const b = classifyCodexApprovalScreen(moved) as CodexPermissionPrompt;
    expect(b.promptId).toBe(a.promptId);
    expect(b.cursor).toBe(2);
  });

  // A screen that is clearly approval-shaped (the footer and question phrase
  // are there) but fails structural validation — e.g. no "No" option, so
  // there is nothing safe to fall back to — must never read as "no prompt at
  // all". Silently treating an unparsed dialog as "nothing here" is exactly
  // the DROVR-41 class of bug this module must not repeat.
  test("an approval-shaped screen that fails to parse is 'unrecognised', never silently 'no prompt'", async () => {
    const raw = await fixture("pane-command-outside-cwd.txt");
    const noReject = raw.replace("  3. No, and tell Codex what to do differently (esc)\n", "");
    const result = classifyCodexApprovalScreen(noReject);
    expect(result).toMatchObject({ kind: "unrecognised" });
    expect((result as { excerpt: string }).excerpt).toContain("Would you like to run the following command?");
  });

  test("an MCP dialog missing its Cancel option is 'unrecognised', not guessed at", async () => {
    const raw = await fixture("pane-mcp-tool.txt");
    const noCancel = raw.replace("    4. Cancel                  Cancel this tool call\n", "");
    expect(classifyCodexApprovalScreen(noCancel)).toMatchObject({ kind: "unrecognised" });
  });

  test("a bare footer with no recognisable question is still 'unrecognised', not 'no prompt'", () => {
    const result = classifyCodexApprovalScreen("Something unexpected\n\n  Press enter to confirm or esc to cancel");
    expect(result).toMatchObject({ kind: "unrecognised" });
  });

  // Sighting counts per fingerprint (FACTORY-388) need a fingerprint stable
  // across polls of the SAME unrecognised dialog even while its cursor
  // moves — otherwise every poll would mint a "new" fingerprint and a host
  // could never count sightings of one shape.
  test("an unrecognised dialog's fingerprint names its shape, not where the cursor sits", async () => {
    const raw = await fixture("pane-mcp-tool.txt");
    const badMcp = raw.replace("    4. Cancel                  Cancel this tool call\n", "");
    const moved = badMcp
      .replace("  › 1. Allow", "    1. Allow")
      .replace("    2. Allow for this session", "  › 2. Allow for this session");
    const a = classifyCodexApprovalScreen(badMcp) as { kind: "unrecognised"; fingerprint: string };
    const b = classifyCodexApprovalScreen(moved) as { kind: "unrecognised"; fingerprint: string };
    expect(a.kind).toBe("unrecognised");
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  test("two differently-shaped unrecognised dialogs fingerprint distinctly", async () => {
    const badMcp = (await fixture("pane-mcp-tool.txt")).replace("    4. Cancel                  Cancel this tool call\n", "");
    const bareFooter = classifyCodexApprovalScreen("Something unexpected\n\n  Press enter to confirm or esc to cancel") as { fingerprint: string };
    const badMcpResult = classifyCodexApprovalScreen(badMcp) as { fingerprint: string };
    expect(bareFooter.fingerprint).not.toBe(badMcpResult.fingerprint);
  });
});

describe("onceOptionIndex", () => {
  test("never the stored-rule / session / always variant, for every captured kind", async () => {
    for (const name of ["pane-command-outside-cwd.txt", "pane-command-network.txt", "pane-file-edit.txt", "pane-mcp-tool.txt"]) {
      const prompt = classifyCodexApprovalScreen(await fixture(name)) as CodexPermissionPrompt;
      const target = onceOptionIndex(prompt);
      expect(target).toBeGreaterThanOrEqual(0);
      const chosen = prompt.options[target]!;
      expect(chosen).not.toMatch(/don't ask again/);
      expect(chosen).not.toMatch(/Allow for this session/);
      expect(chosen).not.toMatch(/Always allow/);
    }
  });

  test("-1 when the dialog offers no plain approve-once option", () => {
    const prompt: CodexPermissionPrompt = {
      kind: "mcp-tool", detail: "x.y", cursor: 0, promptId: "abc",
      options: ["Allow for this session  …", "Always allow  …", "Cancel  …"],
    };
    expect(onceOptionIndex(prompt)).toBe(-1);
  });
});

// Reading a pane never advances its own script — only a sent key does (the
// pane's screen only changes once a key actually lands), matching
// `permission-approval.test.ts`'s own fixture harness.
function codexClient(panes: Record<string, { reads: string[]; agent?: string; hangAfterReads?: number; throwOnRead?: boolean }>) {
  const keysSent: Record<string, string[][]> = {};
  const readCounts: Record<string, number> = {};
  const client = {
    agent: {
      list: async () => ({
        type: "agent_list",
        agents: Object.entries(panes).map(([paneId, p]) => ({ pane_id: paneId, agent: p.agent ?? "codex", name: paneId, agent_status: "blocked" })),
      }) as never,
      get: async (target: string) => ({ type: "agent_info", agent: { pane_id: target, name: target } }) as never,
      read: async (p: { target: string }) => {
        const script = panes[p.target];
        const count = (readCounts[p.target] = (readCounts[p.target] ?? 0) + 1);
        if (script?.hangAfterReads !== undefined && count > script.hangAfterReads) return new Promise<never>(() => undefined);
        if (script?.throwOnRead) throw new Error("read exploded");
        const text = script?.reads[0] ?? NO_PROMPT;
        return { type: "pane_read", read: { text } } as never;
      },
      sendKeys: async (p: { target: string; keys: string[] }) => {
        (keysSent[p.target] ??= []).push(p.keys);
        panes[p.target]?.reads.shift();
        return { type: "ok" } as never;
      },
    },
  };
  return { client, keysSent };
}

describe("scanPendingCodexApprovals", () => {
  test("only codex panes are scanned; a Claude pane in blocked state is ignored entirely", async () => {
    const cmd = await fixture("pane-command-outside-cwd.txt");
    const { client } = codexClient({
      "w1:p1": { reads: [cmd] },
      "w2:p1": { reads: [cmd], agent: "claude" },
    });
    const result = await scanPendingCodexApprovals(client);
    expect(result.pending.map((p) => p.paneId)).toEqual(["w1:p1"]);
  });

  test("pending, unrecognised and unreadable panes are all reported, never merged or dropped", async () => {
    const cmd = await fixture("pane-command-outside-cwd.txt");
    const badMcp = (await fixture("pane-mcp-tool.txt")).replace("    4. Cancel                  Cancel this tool call\n", "");
    const { client } = codexClient({
      "w1:p1": { reads: [cmd] },
      "w2:p1": { reads: [badMcp] },
      "w3:p1": { reads: [], throwOnRead: true },
    });
    const result = await scanPendingCodexApprovals(client);
    expect(result.pending.map((p) => p.paneId)).toEqual(["w1:p1"]);
    expect(result.unrecognised.map((p) => p.paneId)).toEqual(["w2:p1"]);
    expect(result.unreadable.map((p) => p.paneId)).toEqual(["w3:p1"]);
  });
});

describe("approveCodexApproval", () => {
  const base = { paneId: "w1:p1", operator: "brooswit", auditPath: "/audit.jsonl" };

  function deps() {
    const audit: Record<string, unknown>[] = [];
    let clock = 0;
    return {
      appendAudit: async (_path: string, line: string) => { audit.push(JSON.parse(line)); },
      now: () => new Date(Date.UTC(2026, 8, 26) + clock),
      wait: async (ms: number) => { clock += ms; },
      verifyTimeoutMs: 1_000,
      pollMs: 250,
      audit,
    };
  }

  test("answers 'Yes, proceed' once, verifies the prompt cleared, audits before and after with vendor: codex", async () => {
    const cmd = await fixture("pane-command-outside-cwd.txt");
    const { client, keysSent } = codexClient({ "w1:p1": { reads: [cmd] } });
    const prompt = classifyCodexApprovalScreen(cmd) as CodexPermissionPrompt;
    const d = deps();
    const result = await approveCodexApproval(client, { ...base, promptId: prompt.promptId }, d);
    expect(result).toMatchObject({ ok: true, kind: "command" });
    expect(keysSent["w1:p1"]).toEqual([["enter"]]);
    expect(d.audit.map((r) => r.outcome)).toEqual(["approving", "approved"]);
    expect(d.audit[0]).toMatchObject({ vendor: "codex", operator: "brooswit", paneId: "w1:p1", scope: "once", option: "Yes, proceed (y)" });
  });

  test("answers the MCP tool dialog's plain 'Allow', never 'Allow for this session' or 'Always allow'", async () => {
    const mcp = await fixture("pane-mcp-tool.txt");
    const { client, keysSent } = codexClient({ "w1:p1": { reads: [mcp] } });
    const prompt = classifyCodexApprovalScreen(mcp) as CodexPermissionPrompt;
    const result = await approveCodexApproval(client, { ...base, promptId: prompt.promptId }, deps());
    expect(result).toMatchObject({ ok: true, kind: "mcp-tool" });
    expect(keysSent["w1:p1"]).toEqual([["enter"]]);
  });

  test("a different prompt than the caller saw is refused, nothing pressed", async () => {
    const cmd = await fixture("pane-command-outside-cwd.txt");
    const net = await fixture("pane-command-network.txt");
    const { client, keysSent } = codexClient({ "w1:p1": { reads: [net] } });
    const cmdPrompt = classifyCodexApprovalScreen(cmd) as CodexPermissionPrompt;
    const d = deps();
    const result = await approveCodexApproval(client, { ...base, promptId: cmdPrompt.promptId }, d);
    expect(result).toMatchObject({ ok: false, reason: "prompt-changed" });
    expect(keysSent["w1:p1"]).toBeUndefined();
    expect(d.audit.map((r) => r.outcome)).toEqual(["prompt-changed"]);
  });

  test("an unrecognised dialog is refused, logged to the audit trail, and never pressed — a human must answer it", async () => {
    const badMcp = (await fixture("pane-mcp-tool.txt")).replace("    4. Cancel                  Cancel this tool call\n", "");
    const { client, keysSent } = codexClient({ "w1:p1": { reads: [badMcp] } });
    const d = deps();
    const result = await approveCodexApproval(client, { ...base, promptId: "whatever" }, d);
    expect(result).toMatchObject({ ok: false, reason: "unrecognised" });
    expect(keysSent["w1:p1"]).toBeUndefined();
    expect(d.audit.map((r) => r.outcome)).toEqual(["unrecognised"]);
  });

  test("no prompt, or no operator, is refused and recorded, nothing pressed", async () => {
    const { client, keysSent } = codexClient({ "w1:p1": { reads: [] } });
    const d = deps();
    expect(await approveCodexApproval(client, { ...base, promptId: "x" }, d)).toMatchObject({ ok: false, reason: "no-prompt" });
    expect(await approveCodexApproval(client, { ...base, operator: " ", promptId: "x" }, d)).toMatchObject({ ok: false, reason: "invalid-operator" });
    expect(keysSent["w1:p1"]).toBeUndefined();
    expect(d.audit.map((r) => r.outcome)).toEqual(["no-prompt", "invalid-operator"]);
  });

  test("keys that leave the same prompt on screen are reported as not-cleared, never claimed as approved", async () => {
    const cmd = await fixture("pane-command-outside-cwd.txt");
    const { client } = codexClient({ "w1:p1": { reads: [cmd, cmd] } });
    const prompt = classifyCodexApprovalScreen(cmd) as CodexPermissionPrompt;
    const d = deps();
    const result = await approveCodexApproval(client, { ...base, promptId: prompt.promptId }, d);
    expect(result).toMatchObject({ ok: false, reason: "not-cleared" });
    expect(d.audit.map((r) => r.outcome)).toEqual(["approving", "not-cleared"]);
  });
});

describe("autoAnswerCodexApprovals", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  async function freshAuditPath(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "drovr-codex-auto-answer-"));
    return join(dir, "audit.jsonl");
  }

  async function readAudit(path: string): Promise<Record<string, unknown>[]> {
    const text = await readFile(path, "utf8").catch(() => "");
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  }

  test("a command dialog is answered exactly once, audited as drovr-auto/vendor codex", async () => {
    const cmd = await fixture("pane-command-outside-cwd.txt");
    const path = await freshAuditPath();
    const { client, keysSent } = codexClient({ "w1:p1": { reads: [cmd] } });
    const results = await autoAnswerCodexApprovals(client, { auditPath: path });
    expect(results).toMatchObject([{ paneId: "w1:p1", outcome: "answered", kind: "command" }]);
    expect(keysSent["w1:p1"]).toEqual([["enter"]]);
    const audit = await readAudit(path);
    expect(audit.map((r) => r.outcome)).toEqual(["approving", "approved"]);
    expect(audit[0]).toMatchObject({ operator: "drovr-auto", vendor: "codex", scope: "once" });
  });

  // Never skip silently (the ticket's own rule): an unrecognised approval
  // screen must be reported AND logged, and must never have a key pressed at it.
  test("an unrecognised prompt is logged to the audit trail and never answered", async () => {
    const badMcp = (await fixture("pane-mcp-tool.txt")).replace("    4. Cancel                  Cancel this tool call\n", "");
    const path = await freshAuditPath();
    const { client, keysSent } = codexClient({ "w1:p1": { reads: [badMcp] } });
    const results = await autoAnswerCodexApprovals(client, { auditPath: path });
    expect(results).toMatchObject([{ paneId: "w1:p1", outcome: "unrecognised", fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    expect(keysSent["w1:p1"]).toBeUndefined();
    const audit = await readAudit(path);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: "unrecognised", vendor: "codex", operator: "drovr-auto", fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });

  // `classifyCodexApprovalScreen` itself requires the plain approve-once
  // option to sit at position 0 for a dialog to validate as a known kind at
  // all (same invariant as Claude's `classifyPermissionPrompt`, which
  // requires `options[0] === "Yes"`), so `onceOptionIndex` returning -1 for a
  // *successfully classified* dialog cannot arise through the real
  // classifier; that branch is covered directly on a hand-built prompt in
  // the "onceOptionIndex" describe block above. A dialog whose approve-once
  // option is missing or moved fails classification entirely and is reported
  // as "unrecognised" instead — covered by the test above.

  test("one pane's unrecognised prompt does not stop another pane from being answered", async () => {
    const cmd = await fixture("pane-command-outside-cwd.txt");
    const badMcp = (await fixture("pane-mcp-tool.txt")).replace("    4. Cancel                  Cancel this tool call\n", "");
    const path = await freshAuditPath();
    const { client, keysSent } = codexClient({
      "w1:p1": { reads: [cmd] },
      "w2:p1": { reads: [badMcp] },
    });
    const results = await autoAnswerCodexApprovals(client, { auditPath: path });
    const byPane = Object.fromEntries(results.map((r) => [r.paneId, r]));
    expect(byPane["w1:p1"]).toMatchObject({ outcome: "answered" });
    expect(byPane["w2:p1"]).toMatchObject({ outcome: "unrecognised" });
    expect(keysSent["w1:p1"]).toEqual([["enter"]]);
    expect(keysSent["w2:p1"]).toBeUndefined();
  });

  test("a pane whose approve attempt hangs past readTimeoutMs is failed, without blocking another pane's answer", async () => {
    const cmd = await fixture("pane-command-outside-cwd.txt");
    const path = await freshAuditPath();
    const { client, keysSent } = codexClient({
      "w1:p1": { reads: [cmd] },
      "w2:p1": { reads: [cmd], hangAfterReads: 1 },
    });
    const results = await autoAnswerCodexApprovals(client, { auditPath: path, readTimeoutMs: 20 });
    const byPane = Object.fromEntries(results.map((r) => [r.paneId, r]));
    expect(byPane["w1:p1"]).toMatchObject({ outcome: "answered" });
    expect(byPane["w2:p1"]).toMatchObject({ outcome: "failed", reason: "timeout" });
    expect(keysSent["w1:p1"]).toEqual([["enter"]]);
    expect(keysSent["w2:p1"]).toBeUndefined();
  });
});
