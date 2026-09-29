import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createBlockingEscalationWatcher, type BlockingEscalationHook } from "../src/blocking-escalation.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/too-complex-permission/${name}`, import.meta.url), "utf8");

const TRUST = " Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel";
const MCP = "New MCP server found in this project\n❯ 1. Use this and all future MCP servers\n  2. Continue without\nEnter to confirm";
const PERMISSION = "─────────────────────────\n Bash command\n\n   touch x\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend";
// Real captures (FACTORY-319/FACTORY-318): claude 2.1.251 in an isolated `claude
// --permission-mode default` session in a scratch dir, asked to run a Bash command
// containing a brace with a quote inside it, resp. a zsh <N-M> numeric-range glob — the two
// "too-complex" reasons that leave the "Do you want to proceed?" dialog with no stored-rule
// option at all (see classifyPermissionPrompt's own doc comment and docs/permission-approval.md).
// Same shape files also cover `classifyPermissionPrompt`/`classifyBlockingScreen` recognition
// in test/permission-approval.test.ts and test/blocking-prompts.test.ts.
const TOO_COMPLEX_BRACE_WITH_QUOTE = fixture("brace-with-quote.txt");
const TOO_COMPLEX_ZSH_NUMERIC_RANGE_GLOB = fixture("zsh-numeric-range-glob.txt");
const UNKNOWN_A = "  Something Claude Code added last week?\n\n  ❯ 1. Sure\n    2. Later\n\n  Enter to confirm · Esc to cancel";
const UNKNOWN_B = "  A different unknown menu?\n\n  ❯ 1. Yep\n    2. Nope\n\n  Enter to confirm · Esc to cancel";
const IDLE = "❯ some idle shell prompt, no dialog";
// A side-by-side AskUserQuestion dialog (a preview on one option), captured live the same way as
// blocking-prompts.test.ts's fixture of the same name — see that file for how.
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
    const outcomes = await createBlockingEscalationWatcher(hook, { permissionScope: "once" }).poll(c);
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
    const outcomes = await createBlockingEscalationWatcher(hook, { permissionScope: "once" }).poll(c);
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
    const watcher = createBlockingEscalationWatcher(hook, { permissionScope: "once" });

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
    const watcher = createBlockingEscalationWatcher(hook, { permissionScope: "once" });

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
    const watcher = createBlockingEscalationWatcher(hook, { permissionScope: "once" });

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

  test("an AskUserQuestion dialog with a side-by-side preview escalates with a stable fingerprint and a clean, verbatim payload", async () => {
    const c = client(
      [{ pane_id: "w1:p1", agent_status: "blocked", cwd: "/home/agent/nexus", name: "nexus", agent_session: { kind: "id", value: "s1" } }],
      { "w1:p1": ASK_USER_QUESTION_PREVIEW_SHORT },
    );
    const hook = recordingHook();
    const watcher = createBlockingEscalationWatcher(hook, { permissionScope: "once" });

    const first = await watcher.poll(c);
    expect(first).toEqual([{ paneId: "w1:p1", outcome: "escalated", fingerprint: expect.any(String) }]);
    expect(hook.escalations).toEqual([{
      paneId: "w1:p1", label: "nexus", sessionId: "s1", cwd: "/home/agent/nexus", herdrStatus: "blocked",
      question: "Which migration approach should we use?",
      options: ["Add nullable column then backfill", "Add NOT NULL column with default"],
      fingerprint: expect.any(String),
    }]);

    const second = await watcher.poll(c);
    expect(second).toEqual([]); // same (pane, fingerprint) episode: no repeat call
  });

  // FACTORY-377: describeUnknownDialog used to return any non-blank line
  // above the option block as the question, so chatter landing between the
  // real question and the options corrupted the escalation payload and its
  // fingerprint. Pins both halves of the fix at the level a caller actually
  // observes: the escalated fingerprint.
  describe("chatter lines around a weekly-limit-shaped dialog (FACTORY-377)", () => {
    const CHATTER_FRAME_RULE_LINE = "▔".repeat(94);
    const weeklyLimit = (...chatterAboveFrameRule: string[]) => [
      "some prior pane output",
      "",
      ...(chatterAboveFrameRule.length ? [...chatterAboveFrameRule, CHATTER_FRAME_RULE_LINE] : []),
      "What do you want to do?",
      "",
      "❯ 1. Stop and wait for limit to reset",
      "  2. Wait here, then continue automatically at Oct 1, 8am",
      "  3. Switch to usage credits",
      "",
      "Enter to select · Esc to cancel",
    ].join("\n");

    async function escalatedFingerprint(screen: string): Promise<string | undefined> {
      const c = client([{ pane_id: "w1:p1", agent_status: "blocked" }], { "w1:p1": screen });
      const hook = recordingHook();
      await createBlockingEscalationWatcher(hook, { permissionScope: "once" }).poll(c);
      return (hook.escalations[0] as { fingerprint?: string } | undefined)?.fingerprint;
    }

    test("chatter ABOVE the dialog, never touching the option block, leaves the fingerprint unchanged (the already-good case)", async () => {
      const baseline = await escalatedFingerprint(weeklyLimit());
      expect(baseline).toEqual(expect.any(String));
      for (const n of [0, 1, 3, 9, 20]) {
        const chatter = Array.from({ length: n }, (_, i) => `[butchr] outer chatter ${i + 1}`);
        expect(await escalatedFingerprint([...chatter, "", weeklyLimit()].join("\n"))).toBe(baseline);
      }
    });

    // Real captures show chatter with no common shape between the question
    // and whatever precedes it — distinct notification prefixes, the pane's
    // own prior output, and an unlabelled wrapped continuation line — so
    // this asserts the fingerprint stays stable across several DIFFERENTLY
    // shaped chatter blocks, all sitting above the dialog's own frame rule.
    test("chatter directly above the dialog's own frame rule no longer drifts the fingerprint or drops the real question (the fixed case)", async () => {
      const baseline = await escalatedFingerprint(weeklyLimit());
      const chatterShapes: string[][] = [
        ["[butchr] inner chatter 1"],
        ["❯ [butchr] related:jira-work:FACTORY-328 got a new comment", "  re-read it, then act."],
        ["← butchr: [butchr] Ticket FACTORY-327 got a new comment — re-read it."],
        ["  Called butchr, ran 1 shell command", "✻ Crunched for 9s · done 8:04 PM", "❯ [butchr] Ticket FACTORY-327 was updated — re-read", "  it."],
      ];
      for (const chatter of chatterShapes) {
        expect(await escalatedFingerprint(weeklyLimit(...chatter))).toBe(baseline);
      }
    });

    test("when nothing between the dialog's own frame rule and the option block looks like a question, the dialog is reported, not escalated with a wrong payload", async () => {
      const raw = [
        "[butchr] FACTORY-1 was updated",
        "[butchr] FACTORY-2 was updated",
        CHATTER_FRAME_RULE_LINE,
        "",
        "❯ 1. Stop and wait for limit to reset",
        "  2. Wait here, then continue automatically at Oct 1, 8am",
        "  3. Switch to usage credits",
        "",
        "Enter to select · Esc to cancel",
      ].join("\n");
      const c = client([{ pane_id: "w1:p1", agent_status: "blocked" }], { "w1:p1": raw });
      const hook = recordingHook();
      const outcomes = await createBlockingEscalationWatcher(hook, { permissionScope: "once" }).poll(c);
      expect(outcomes).toEqual([{ paneId: "w1:p1", outcome: "reported", kind: "unknown", name: undefined }]);
      expect(hook.escalations).toEqual([]);
    });

    // The ticket's actual production evidence (FACTORY-327 weekly-limit
    // escalations) is asserted directly against `describeUnknownDialog` in
    // test/blocking-prompts.test.ts, not re-run through this watcher: real
    // captures of this exact dialog classify as `rate-limit-options` (its
    // own dedicated classifier recognises the shape), which this watcher's
    // `escalationPayload` never routes to `describeUnknownDialog` at all —
    // only `unknown` and `permission` dialogs escalate here. That path is
    // untouched by this ticket; asserting a fingerprint through it here
    // would test a classifier this fix doesn't change, not the fix itself.
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
    const outcomes = await createBlockingEscalationWatcher(hook, { permissionScope: "once" }).poll(c);
    expect(outcomes).toContainEqual({ paneId: "w1:p1", outcome: "hook-failed", phase: "escalate", detail: "boom" });
    expect(outcomes).toContainEqual({ paneId: "w2:p1", outcome: "escalated", fingerprint: expect.any(String) });
  });

  // FACTORY-318: the no-stored-rule "too-complex" shape has only three options
  // (Yes / switch-to-auto-mode / No) — `scope: "always"` finds no non-auto-mode
  // "Yes, and …" option on it, so a permission-answer pass running that scope
  // will never answer it. Before this fix that dialog was routed straight to
  // `outcome: "reported"` on the assumption *some* flow would answer it, and
  // the pane hung forever with no fingerprint and no escalation. Now the
  // escalation watcher is told the real scope in use (`permissionScope`) and
  // escalates exactly the dialogs that scope cannot answer.
  describe("a permission dialog the configured permissionScope will not answer (FACTORY-318)", () => {
    test("scope once DOES answer this shape (option 1 is plain 'Yes'), so it stays reported — no escalation", async () => {
      const c = client([{ pane_id: "w1:p1", agent_status: "blocked" }], { "w1:p1": TOO_COMPLEX_BRACE_WITH_QUOTE });
      const hook = recordingHook();
      const outcomes = await createBlockingEscalationWatcher(hook, { permissionScope: "once" }).poll(c);
      expect(outcomes).toEqual([{ paneId: "w1:p1", outcome: "reported", kind: "permission", name: "Bash command" }]);
      expect(hook.escalations).toEqual([]);
    });

    test("scope always does NOT answer this shape, so it escalates with a fingerprint and the verbatim tool/request/reason instead of being silently reported", async () => {
      const c = client(
        [{ pane_id: "w1:p1", agent_status: "blocked", cwd: "/home/agent/nexus", name: "nexus", agent_session: { kind: "id", value: "s1" } }],
        { "w1:p1": TOO_COMPLEX_BRACE_WITH_QUOTE },
      );
      const hook = recordingHook();
      const watcher = createBlockingEscalationWatcher(hook, { permissionScope: "always" });

      const first = await watcher.poll(c);
      expect(first).toEqual([{ paneId: "w1:p1", outcome: "escalated", fingerprint: expect.any(String) }]);
      expect(hook.escalations).toHaveLength(1);
      const escalation = hook.escalations[0] as { paneId: string; question: string; options: string[] };
      expect(escalation.paneId).toBe("w1:p1");
      expect(escalation.question).toContain("Contains brace with quote character (expansion obfuscation)");
      expect(escalation.options).toEqual(["Yes", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);

      // Never escalated twice for the same still-open episode.
      const second = await watcher.poll(c);
      expect(second).toEqual([]);
    });

    test("a sibling too-complex reason with different wording (zsh numeric-range glob) goes through the exact same path", async () => {
      const c = client([{ pane_id: "w1:p1", agent_status: "blocked" }], { "w1:p1": TOO_COMPLEX_ZSH_NUMERIC_RANGE_GLOB });
      const hook = recordingHook();
      const outcomes = await createBlockingEscalationWatcher(hook, { permissionScope: "always" }).poll(c);
      expect(outcomes).toEqual([{ paneId: "w1:p1", outcome: "escalated", fingerprint: expect.any(String) }]);
      const escalation = hook.escalations[0] as { question: string; options: string[] };
      expect(escalation.question).toContain("Contains zsh <N-M> numeric-range glob");
      expect(escalation.options).toEqual(["Yes", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    });

    test("the two sibling too-complex dialogs fingerprint distinctly, even though they share the same question and options text", async () => {
      const c = client([{ pane_id: "w1:p1", agent_status: "blocked" }], { "w1:p1": TOO_COMPLEX_BRACE_WITH_QUOTE });
      const hook = recordingHook();
      const first = await createBlockingEscalationWatcher(hook, { permissionScope: "always" }).poll(c);

      const c2 = client([{ pane_id: "w1:p1", agent_status: "blocked" }], { "w1:p1": TOO_COMPLEX_ZSH_NUMERIC_RANGE_GLOB });
      const hook2 = recordingHook();
      const second = await createBlockingEscalationWatcher(hook2, { permissionScope: "always" }).poll(c2);

      const fp1 = (first[0] as { fingerprint: string }).fingerprint;
      const fp2 = (second[0] as { fingerprint: string }).fingerprint;
      expect(fp1).not.toBe(fp2);
    });
  });
});
