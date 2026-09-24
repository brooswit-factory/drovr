import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  classifyCodexUsageLimitText, classifyProviderQuotaText, codexTurnErrorQuota, parseCodexUsageReset,
} from "../src/index.js";

// Both fixtures are verbatim herdr reads of quota-blocked idle Codex panes,
// taken by the operator on 2026-09-24 (Codex 0.155.0-alpha.16.4).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/codex-usage-limit/${name}`, import.meta.url), "utf8");
const now = new Date(2026, 8, 24, 12, 0, 0);
const sep29 = new Date(2026, 8, 29, 16, 3, 0).getTime();
const banner = "• Automatically switched to Luna Reserve medium due to usage limits.";

describe("classifyCodexUsageLimitText", () => {
  test("recognises the observed Luna Reserve dialog and parses its dated reset", () => {
    const outcome = classifyCodexUsageLimitText(fixture("pane-luna-reserve-dialog.txt"), now);
    expect(outcome).toEqual({ kind: "recognised", resetsAt: sep29, raw: banner.slice(2) });
  });

  test("recognises the observed bare notice before the composer, with no invented reset", () => {
    expect(classifyCodexUsageLimitText(fixture("pane-luna-reserve-composer.txt"), now))
      .toEqual({ kind: "recognised", resetsAt: null, raw: banner.slice(2) });
    // An indented composer footer is still idle chrome.
    const footer = fixture("pane-luna-reserve-composer.txt") + "\n  ? for shortcuts                 100% context left\n";
    expect(classifyCodexUsageLimitText(footer, now).kind).toBe("recognised");
  });

  test("a later history cell means the agent carried on; the notice is suppressed", () => {
    for (const later of ["• Continuing on Luna Reserve: running the tests now.", "■ Conversation interrupted", "─ Worked for 2m 04s ─────"]) {
      const outcome = classifyCodexUsageLimitText(`${fixture("pane-luna-reserve-dialog.txt")}\n${later}\n\n› Ask Codex to do anything\n`, now);
      expect(outcome.kind).toBe("suppressed");
      expect(outcome.kind === "suppressed" && outcome.reason).toContain("later history cell");
    }
  });

  test("a switch back to ordinary usage after the notice is not a refusal", () => {
    const text = `${banner}\n\n• Automatically switched back to gpt-5.5 because ordinary usage is available again.\n\n› Ask Codex to do anything\n`;
    expect(classifyCodexUsageLimitText(text, now)).toEqual({ kind: "not-recognised" });
    // ...but a fresh notice after the switch back is live again.
    expect(classifyCodexUsageLimitText(`${text}\n${banner}\n`, now).kind).toBe("recognised");
  });

  test("indented, quoted, or reworded text is never a notice", () => {
    for (const text of [
      `  └ ${banner}`,
      `    ${banner}`,
      `• Ran grep -n "due to usage limits" drovr/test\n  └ ${banner}\n\n› Ask Codex to do anything`,
      "• Automatically switched to Luna Reserve medium due to usage limits",
      "• Switched to Luna Reserve medium due to usage limits.",
      "• The pane said: Automatically switched to Luna due to usage limits.",
      "HTTP 429 Too Many Requests: rate limit reached; retry later",
      "You've hit your session limit · resets 5:10pm",
      "",
    ]) expect(classifyCodexUsageLimitText(text, now)).toEqual({ kind: "not-recognised" });
  });

  test("a usage-limit error cell is recognised with its retry time", () => {
    const text = "■ You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at\n  Sep 29th, 2026 4:03 PM.\n\n› Ask Codex to do anything\n";
    expect(classifyCodexUsageLimitText(text, now)).toEqual({
      kind: "recognised", resetsAt: sep29,
      raw: "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at",
    });
    expect(classifyCodexUsageLimitText("■ Something else failed", now)).toEqual({ kind: "not-recognised" });
  });

  test("the provider dispatcher keeps each classifier to its own provider", () => {
    const codexPane = fixture("pane-luna-reserve-dialog.txt");
    const claudePane = "You've hit your session limit · resets 5:10pm";
    expect(classifyProviderQuotaText("codex", codexPane, now).kind).toBe("recognised");
    expect(classifyProviderQuotaText("claude", codexPane, now).kind).toBe("not-recognised");
    expect(classifyProviderQuotaText("codex", claudePane, now).kind).toBe("not-recognised");
    expect(classifyProviderQuotaText("claude", claudePane, now).kind).toBe("recognised");
    expect(classifyProviderQuotaText("agy", codexPane, now).kind).toBe("not-recognised");
  });
});

describe("parseCodexUsageReset", () => {
  test("dialog form: 24-hour clock, day, month, optional year, in local time", () => {
    expect(parseCodexUsageReset("wait for usage to reset after\n  16:03 on 29 Sep.", now)).toBe(sep29);
    expect(parseCodexUsageReset("reset after 16:03 on 29 Sep 2027", now)).toBe(new Date(2027, 8, 29, 16, 3).getTime());
    // Nearest occurrence: a January reset read in late December is next year.
    expect(parseCodexUsageReset("reset after 09:00 on 2 Jan", new Date(2026, 11, 30, 12, 0))).toBe(new Date(2027, 0, 2, 9, 0).getTime());
    // A reset that already passed stays in the past (the account is available again).
    expect(parseCodexUsageReset("reset after 16:03 on 20 Sep", now)).toBe(new Date(2026, 8, 20, 16, 3).getTime());
  });

  test("error form: time only rolls to the next occurrence, dated forms keep their date", () => {
    expect(parseCodexUsageReset("try again at 4:03 PM.", now)).toBe(new Date(2026, 8, 24, 16, 3).getTime());
    expect(parseCodexUsageReset("try again at 9:15 AM.", now)).toBe(new Date(2026, 8, 25, 9, 15).getTime());
    expect(parseCodexUsageReset("try again at Sep 29 at 4:03 PM.", now)).toBe(sep29);
    expect(parseCodexUsageReset("try again at Sep 29th, 2026 4:03 PM.", now)).toBe(sep29);
  });

  test("unparseable or impossible resets are null, never invented", () => {
    for (const text of [
      "wait for usage to reset soon", "reset after 25:00 on 29 Sep", "reset after 16:61 on 29 Sep",
      "reset after 16:03 on 31 Sep", "reset after 16:03 on 29 Foo", "try again at 13:03 PM", "try again later",
    ]) expect(parseCodexUsageReset(text, now)).toBeNull();
  });
});

describe("codexTurnErrorQuota", () => {
  test("the observed App Server turn error is a quota refusal", () => {
    const message = "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 29th, 2026 4:03 PM.";
    expect(codexTurnErrorQuota({ message, codexErrorInfo: "usageLimitExceeded" }, now)).toEqual({ raw: message, resetsAt: sep29 });
    expect(codexTurnErrorQuota({ message: "You've hit your usage limit." }, now)).toEqual({ raw: "You've hit your usage limit.", resetsAt: null });
    expect(codexTurnErrorQuota("You’ve hit your usage limit.", now)?.raw).toBe("You’ve hit your usage limit.");
  });

  test("the structured App Server code alone is sufficient", () => {
    expect(codexTurnErrorQuota({ message: "Usage limit reached.", codexErrorInfo: "usageLimitExceeded" }, now))
      .toEqual({ raw: "Usage limit reached.", resetsAt: null });
    expect(codexTurnErrorQuota({ codexErrorInfo: { usageLimitExceeded: {} } }, now)).toEqual({ raw: "usageLimitExceeded", resetsAt: null });
  });

  test("other failures, and messages that merely mention the limit, are not quota", () => {
    for (const error of [
      { message: "stream disconnected before completion" },
      { message: "Rate limit reached for requests", codexErrorInfo: "rateLimitExceeded" },
      { message: "Tool output: You’ve hit your usage limit." },
      { message: "unexpected status 429 Too Many Requests" },
      { codexErrorInfo: "contextWindowExceeded" },
      "", null, undefined, 429,
    ]) expect(codexTurnErrorQuota(error, now)).toBeNull();
  });
});
