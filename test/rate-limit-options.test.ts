import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyBlockingScreen } from "../src/blocking-prompts.js";
import { classifyPermissionPrompt } from "../src/permission-approval.js";
import {
  answerRateLimitOptions,
  classifyRateLimitOptions,
  parseWaitHereReset,
  resolveRateLimitOptionsAction,
  type RateLimitOptionsPrompt,
} from "../src/rate-limit-options.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/rate-limit-options/${name}`, import.meta.url), "utf8");
const fixtureBytes = (name: string) => readFileSync(new URL(`./fixtures/rate-limit-options/${name}`, import.meta.url));

const REAL_FIXTURES = [
  "pane-cap-escalation-20260927T030643Z.txt",
  "pane-cap-escalation-20260927T030721Z.txt",
  "pane-cap-escalation-20260927T030736Z.txt",
];

// Hand-built, for the exact shape Claude Code draws (see src/rate-limit-options.ts's module doc).
const CLEAN_DIALOG = [
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   What do you want to do?",
  "",
  "   ❯ 1. Stop and wait for limit to reset",
  "     2. Wait here, then continue automatically at Oct 1, 8am",
  "     3. Switch to usage credits",
  "",
  "   Enter to confirm · Esc to cancel",
].join("\n");

describe("classifyRateLimitOptions", () => {
  test("recognises the hand-built clean dialog by its option labels", () => {
    const prompt = classifyRateLimitOptions(CLEAN_DIALOG)!;
    expect(prompt).not.toBeUndefined();
    expect(prompt.options).toEqual([
      "Stop and wait for limit to reset",
      "Wait here, then continue automatically at Oct 1, 8am",
      "Switch to usage credits",
    ]);
    expect(prompt.cursor).toBe(0);
    expect(prompt.stopIndex).toBe(0);
    expect(prompt.waitHereIndex).toBe(1);
    expect(prompt.switchIndex).toBe(2);
  });

  test("recognises all three real captures (FACTORY-327), each with different interleaved butchr chatter above the dialog", () => {
    const ids = new Set<string>();
    for (const name of REAL_FIXTURES) {
      const prompt = classifyRateLimitOptions(fixture(name));
      expect(prompt, `${name} should be recognised`).not.toBeUndefined();
      expect(prompt!.options[prompt!.waitHereIndex]).toContain("Wait here, then continue automatically");
      expect(prompt!.options[prompt!.stopIndex]).toBe("Stop and wait for limit to reset");
      expect(prompt!.options[prompt!.switchIndex]).toBe("Switch to usage credits");
      ids.add(prompt!.promptId);
    }
    // Same three verbatim option labels in every capture -> the same promptId,
    // regardless of how much unrelated chatter sits above the dialog.
    expect(ids.size).toBe(1);
  });

  // FACTORY-345 comment 26620 (measured against drovr main c6da5fc): chatter
  // landing INSIDE blocking-prompts.ts's QUESTION_TAIL window (directly above
  // the option block) corrupts describeUnknownDialog's extracted "question"
  // and drifts its fingerprint. This recognizer never reads the question at
  // all, precisely to stay clear of that fragility -- assert it here directly.
  test("recognition is unaffected by chatter injected directly between the question and the option block", () => {
    const withoutChatter = classifyRateLimitOptions(CLEAN_DIALOG)!;
    const lines = CLEAN_DIALOG.split("\n");
    const optionStart = lines.findIndex((l) => l.includes("1. Stop and wait"));
    for (const chatterLines of [1, 2, 5]) {
      const chatter = Array.from({ length: chatterLines }, (_, i) => `[butchr] inner chatter ${i + 1}`);
      const withChatter = [...lines.slice(0, optionStart), ...chatter, ...lines.slice(optionStart)].join("\n");
      const prompt = classifyRateLimitOptions(withChatter);
      expect(prompt, `${chatterLines} chatter line(s) should not break recognition`).not.toBeUndefined();
      expect(prompt!.promptId).toBe(withoutChatter.promptId);
    }
  });

  test("does not recognise the same options relabelled or reordered without the exact wording", () => {
    const relabelled = CLEAN_DIALOG.replace("Stop and wait for limit to reset", "Cancel the session");
    expect(classifyRateLimitOptions(relabelled)).toBeUndefined();
  });

  test("requires the exact footer immediately after the options (blank lines only)", () => {
    const noFooter = CLEAN_DIALOG.replace("   Enter to confirm · Esc to cancel", "   press enter");
    expect(classifyRateLimitOptions(noFooter)).toBeUndefined();
  });

  test("requires exactly one cursor among the three options", () => {
    const noCursor = CLEAN_DIALOG.replace("❯ 1.", "  1.");
    expect(classifyRateLimitOptions(noCursor)).toBeUndefined();
    const twoCursors = CLEAN_DIALOG.replace("2. Wait here", "❯ 2. Wait here");
    expect(classifyRateLimitOptions(twoCursors)).toBeUndefined();
  });
});

// FACTORY-347 AC4 / the safety-critical constraint (rate-limit-options.ts's
// module doc): this dialog must NEVER be recognised as a permission prompt,
// because classifyPermissionPrompt's "Yes"/"No" gate being absent for this
// shape is the only thing stopping an unattended permission-answering pass
// from pressing option 1 ("Stop and wait for limit to reset"), which ends
// the session. This is the single most important test in this file.
describe("classifyPermissionPrompt regression guard (AC4)", () => {
  test("never classifies the rate-limit-options dialog as a permission prompt", () => {
    expect(classifyPermissionPrompt(CLEAN_DIALOG)).toBeUndefined();
    for (const name of REAL_FIXTURES) {
      expect(classifyPermissionPrompt(fixture(name)), `${name} must not be a permission prompt`).toBeUndefined();
    }
  });
});

describe("classifyBlockingScreen integration", () => {
  test("classifies the dialog as its own kind, not permission or unknown", () => {
    const result = classifyBlockingScreen(CLEAN_DIALOG)!;
    expect(result.kind).toBe("rate-limit-options");
    expect(result.rateLimitOptions).not.toBeUndefined();
    expect(result.rateLimitOptions!.waitHereIndex).toBe(1);
  });

  test("classifies all three real captures the same way", () => {
    for (const name of REAL_FIXTURES) {
      const result = classifyBlockingScreen(fixture(name))!;
      expect(result.kind, `${name} should classify as rate-limit-options`).toBe("rate-limit-options");
    }
  });

  test("a genuinely unrecognised dialog still falls through to 'unknown' (AC6 depends on this)", () => {
    const otherMenu = " Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel";
    const result = classifyBlockingScreen(otherMenu);
    // classifyStartupPrompt recognises the real trust dialog; this asserts
    // only that it is NOT swallowed into rate-limit-options.
    expect(result?.kind).not.toBe("rate-limit-options");
  });
});

describe("resolveRateLimitOptionsAction (AC2, AC3, AC5)", () => {
  const promptWith = (waitHereLabel: string): RateLimitOptionsPrompt => ({
    options: ["Stop and wait for limit to reset", waitHereLabel, "Switch to usage credits"],
    cursor: 0,
    stopIndex: 0,
    waitHereIndex: 1,
    switchIndex: 2,
    promptId: "test",
  });

  test("presses option 2 (wait) while the printed reset is in the future", () => {
    const now = new Date(2026, 8, 27, 12, 0, 0); // Sep 27, noon
    const action = resolveRateLimitOptionsAction(promptWith("Wait here, then continue automatically at Oct 1, 8am"), now);
    expect(action).toEqual({ kind: "wait", targetIndex: 1 });
  });

  test("NEVER resolves to an action that targets stopIndex or switchIndex, for any label/time combination", () => {
    const now = new Date(2026, 8, 27, 12, 0, 0);
    for (const label of [
      "Wait here, then continue automatically at Oct 1, 8am",
      "Wait here, then continue automatically at Sep 1, 8am", // already past
      "Wait here, then continue automatically", // unparseable
    ]) {
      const prompt = promptWith(label);
      const action = resolveRateLimitOptionsAction(prompt, now);
      if (action.kind === "wait") {
        expect(action.targetIndex).not.toBe(prompt.stopIndex);
        expect(action.targetIndex).not.toBe(prompt.switchIndex);
        expect(action.targetIndex).toBe(prompt.waitHereIndex);
      }
      // "escape" never targets any option index at all -- it presses Escape.
    }
  });

  test("stale case: escapes rather than waits once the printed reset has already passed", () => {
    const now = new Date(2026, 9, 2, 9, 0, 0); // Oct 2, after an Oct 1 8am reset
    const action = resolveRateLimitOptionsAction(promptWith("Wait here, then continue automatically at Oct 1, 8am"), now);
    expect(action.kind).toBe("escape");
  });

  test("unparseable reset time resolves to 'wait', not 'escape' (never risks an unwarranted escape)", () => {
    const now = new Date(2026, 8, 27, 12, 0, 0);
    const action = resolveRateLimitOptionsAction(promptWith("Wait here, then continue automatically"), now);
    expect(action).toEqual({ kind: "wait", targetIndex: 1 });
  });
});

describe("parseWaitHereReset", () => {
  test("parses the observed label format", () => {
    const now = new Date(2026, 8, 27, 12, 0, 0);
    const resetAt = parseWaitHereReset("Wait here, then continue automatically at Oct 1, 8am", now);
    expect(resetAt).toBe(new Date(2026, 9, 1, 8, 0, 0).getTime());
  });

  test("returns null for text with no parseable clock time", () => {
    expect(parseWaitHereReset("Wait here, then continue automatically", new Date())).toBeNull();
  });
});

describe("answerRateLimitOptions (fake client)", () => {
  function fakeClient(screens: string[]) {
    let i = 0;
    const sent: string[][] = [];
    return {
      client: {
        agent: {
          read: async () => ({ type: "pane_read", read: { text: screens[Math.min(i++, screens.length - 1)]! } }) as never,
          sendKeys: async ({ keys }: { keys: string[] }) => {
            sent.push(keys);
            return { type: "ok" } as never;
          },
        },
      },
      sent,
    };
  }

  test("presses down then enter to reach the wait-here option, never up toward stopIndex", async () => {
    const { client, sent } = fakeClient([CLEAN_DIALOG]);
    const prompt = classifyRateLimitOptions(CLEAN_DIALOG)!;
    const result = await answerRateLimitOptions(client, "pane-1", prompt.promptId, new Date(2026, 8, 27));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toEqual({ kind: "wait", targetIndex: 1 });
    expect(sent).toEqual([["down", "enter"]]);
  });

  test("refuses when the prompt has changed since classification", async () => {
    const { client } = fakeClient([CLEAN_DIALOG]);
    const result = await answerRateLimitOptions(client, "pane-1", "not-the-real-promptid", new Date());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("prompt-changed");
  });

  test("refuses when the pane no longer shows the dialog at all", async () => {
    const { client } = fakeClient(["some unrelated screen"]);
    const result = await answerRateLimitOptions(client, "pane-1", "anything", new Date());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-prompt");
  });

  test("sends a bare Escape, not arrow keys toward an option, for the stale case", async () => {
    const staleDialog = CLEAN_DIALOG.replace(
      "Wait here, then continue automatically at Oct 1, 8am",
      "Wait here, then continue automatically at Sep 1, 8am",
    );
    const { client, sent } = fakeClient([staleDialog]);
    const prompt = classifyRateLimitOptions(staleDialog)!;
    const result = await answerRateLimitOptions(client, "pane-1", prompt.promptId, new Date(2026, 8, 27));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.kind).toBe("escape");
    expect(sent).toEqual([["escape"]]);
  });
});

// AC7: a pane that merely DISPLAYS this dialog's text without being live
// must not be answered as though it were live. Documented in
// src/rate-limit-options.ts's module doc as a KNOWN, BOUNDED residual risk
// (the same class session-limit.ts documents): this module has no further
// structural signal in flattened pane text to close it, and this test
// records that explicitly rather than asserting a guarantee that doesn't
// hold. A `grep`/`cat`/`Read` of one of this file's own fixtures, landing
// verbatim at a pane's tail, IS recognised here -- by design, this module
// relies on the SAME idle/done gate its callers already apply to
// permission-approval.ts and session-limit.ts, not on a structural signal of
// its own.
describe("AC7: printed-text false positive (documented residual risk, not closed)", () => {
  test("a bare Read/cat/grep of a fixture's exact bytes is recognised the same as a live pane -- known, not a bug", () => {
    const asIfCatted = fixtureBytes(REAL_FIXTURES[0]!).toString("utf8");
    expect(classifyRateLimitOptions(asIfCatted)).not.toBeUndefined();
  });
});
