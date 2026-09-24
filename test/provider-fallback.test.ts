import { describe, expect, test } from "bun:test";
import {
  ProviderAvailabilityRegistry, processProviderAvailability, runWithProviderFallback,
  selectAvailableProvider, type ProviderAccount,
} from "../src/index.js";

const claude: ProviderAccount = { provider: "claude", accountId: "shared" };
const codex: ProviderAccount = { provider: "codex", accountId: "shared" };
const other: ProviderAccount = { provider: "claude", accountId: "other" };
const refusal = { resetsAt: null, raw: "confirmed quota refusal" };

describe("account availability", () => {
  test("shares across account references, isolates providers/accounts, expires at reset", () => {
    let now = 100;
    const state = new ProviderAvailabilityRegistry(() => now);
    state.markQuotaBlocked(claude, { ...refusal, resetsAt: 200 });
    expect(state.get({ ...claude }).status).toBe("quota-blocked");
    expect(state.get(codex).status).toBe("available");
    expect(state.get(other).status).toBe("available");
    now = 199;
    expect(selectAvailableProvider([claude, codex], state)).toEqual({ status: "selected", account: codex });
    now = 200;
    expect(selectAvailableProvider([claude, codex], state)).toEqual({ status: "selected", account: claude });
  });

  test("unknown reset stays blocked until explicitly cleared", () => {
    let now = 100;
    const state = new ProviderAvailabilityRegistry(() => now);
    state.markQuotaBlocked(claude, refusal);
    now += 365 * 86_400_000;
    expect(selectAvailableProvider([claude], state)).toEqual({ status: "exhausted" });
    state.clear(claude);
    expect(state.get(claude)).toEqual({ status: "available" });
  });

  test("merges concurrent pane reports monotonically without losing a known reset", () => {
    const state = new ProviderAvailabilityRegistry(() => 100);
    state.markQuotaBlocked(claude, refusal);
    state.markQuotaBlocked(claude, { raw: "first", resetsAt: 300 });
    state.markQuotaBlocked(claude, { raw: "delayed earlier", resetsAt: 200 });
    state.markQuotaBlocked(claude, refusal);
    expect(state.get(claude)).toEqual({ status: "quota-blocked", raw: "first", resetsAt: 300 });
    state.markQuotaBlocked(claude, { raw: "later", resetsAt: 400 });
    expect(state.get(claude)).toEqual({ status: "quota-blocked", raw: "later", resetsAt: 400 });
  });

  test("classifies only Claude idle/done, and healthy text does not clear shared quota", () => {
    const state = new ProviderAvailabilityRegistry();
    const text = "You've hit your session limit";
    for (const status of ["working", "running", "unknown", ""]) {
      expect(state.observeClaudePane(claude, status, text)).toEqual({ kind: "not-recognised" });
    }
    expect(state.observeClaudePane(codex, "idle", text)).toEqual({ kind: "not-recognised" });
    expect(state.get(claude).status).toBe("available");
    expect(state.observeClaudePane(claude, "done", text).kind).toBe("recognised");
    expect(state.observeClaudePane(claude, "idle", "HTTP 429: rate limit; retry later").kind).toBe("not-recognised");
    expect(state.get(claude).status).toBe("quota-blocked");
    expect(state.get(codex).status).toBe("available");
  });

  test("a Codex usage-limit pane blocks only the Codex account, idle/done only, until its reset", () => {
    let now = new Date(2026, 8, 24, 12, 0).getTime();
    const state = new ProviderAvailabilityRegistry(() => now);
    const pane = "• Automatically switched to Luna Reserve medium due to usage limits.\n"
      + "  Add credits to continue using the most advanced models, or wait for usage to reset after\n"
      + "  16:03 on 29 Sep.\n› 1. Add Credits\n  2. Continue with Luna Reserve\n";
    for (const status of ["working", "blocked", "unknown", ""]) {
      expect(state.observePane(codex, status, pane)).toEqual({ kind: "not-recognised" });
    }
    expect(state.observeClaudePane(codex, "idle", pane)).toEqual({ kind: "not-recognised" });
    expect(state.observePane(claude, "idle", pane)).toEqual({ kind: "not-recognised" });
    expect(state.observePane({ provider: "agy", accountId: "shared" }, "idle", pane)).toEqual({ kind: "not-recognised" });
    expect(state.get(codex).status).toBe("available");
    const resetsAt = new Date(2026, 8, 29, 16, 3).getTime();
    expect(state.observePane(codex, "idle", pane)).toMatchObject({ kind: "recognised", resetsAt });
    expect(state.get(codex)).toMatchObject({ status: "quota-blocked", resetsAt });
    expect(state.get(claude).status).toBe("available");
    // Priority is re-walked from the top: Claude first while Codex is blocked...
    expect(selectAvailableProvider([codex, claude], state)).toEqual({ status: "selected", account: claude });
    // ...and Codex regains its own position once its reset passes.
    now = resetsAt;
    expect(selectAvailableProvider([codex, claude], state)).toEqual({ status: "selected", account: codex });
  });

  test("rejects malformed reset metadata and empty identities", () => {
    const state = new ProviderAvailabilityRegistry();
    for (const resetsAt of [NaN, Infinity, -Infinity]) {
      expect(() => state.markQuotaBlocked(claude, { ...refusal, resetsAt })).toThrow();
    }
    expect(() => state.get({ ...claude, accountId: " " })).toThrow();
  });
});

describe("ordered quota fallback", () => {
  test("quota refusal advances in order and persists for subsequent work", async () => {
    const availability = new ProviderAvailabilityRegistry();
    const calls: ProviderAccount[] = [];
    const result = await runWithProviderFallback({
      priority: [claude, codex], availability,
      attempt: async account => {
        calls.push(account);
        return account.provider === "claude"
          ? { status: "quota-blocked", refusal }
          : { status: "success", value: "pane-2" };
      },
    });
    expect(calls).toEqual([claude, codex]);
    expect(result).toEqual({ status: "success", account: codex, value: "pane-2", attempted: calls });
    expect(selectAvailableProvider([claude, codex], availability)).toEqual({ status: "selected", account: codex });
  });

  test("attempts duplicate accounts once even when their reported reset already passed", async () => {
    const availability = new ProviderAvailabilityRegistry(() => 100);
    const calls: ProviderAccount[] = [];
    const result = await runWithProviderFallback({
      priority: [claude, { ...claude }, codex, claude], availability,
      attempt: async account => {
        calls.push(account);
        return { status: "quota-blocked", refusal: { ...refusal, resetsAt: 99 } };
      },
    });
    expect(calls).toEqual([claude, codex]);
    expect(result).toEqual({ status: "exhausted", reason: "no-available-provider", attempted: calls });
  });

  test("explicit bound limits attempts and excludes skipped accounts from the count", async () => {
    const availability = new ProviderAvailabilityRegistry();
    availability.markQuotaBlocked(claude, refusal);
    const result = await runWithProviderFallback({
      priority: [claude, codex, other], availability, maxAttempts: 1,
      attempt: async () => ({ status: "quota-blocked", refusal }),
    });
    expect(result).toEqual({ status: "exhausted", reason: "attempt-limit", attempted: [codex] });
    expect(availability.get(other).status).toBe("available");
  });

  test("empty/all-blocked/zero-bound configurations never invoke the callback", async () => {
    const availability = new ProviderAvailabilityRegistry();
    const attempt = async (): Promise<never> => { throw new Error("must not run"); };
    expect(await runWithProviderFallback({ priority: [], availability, attempt })).toEqual({
      status: "exhausted", reason: "no-available-provider", attempted: [],
    });
    expect(await runWithProviderFallback({ priority: [claude], availability, attempt, maxAttempts: 0 })).toEqual({
      status: "exhausted", reason: "attempt-limit", attempted: [],
    });
    availability.markQuotaBlocked(claude, refusal);
    expect(await runWithProviderFallback({ priority: [claude], availability, attempt })).toEqual({
      status: "exhausted", reason: "no-available-provider", attempted: [],
    });
  });

  test("arbitrary errors propagate by identity even when they contain quota words", async () => {
    const availability = new ProviderAvailabilityRegistry();
    const error = new Error("You've hit your session limit; HTTP 429");
    const calls: ProviderAccount[] = [];
    await expect(runWithProviderFallback({
      priority: [claude, codex], availability,
      attempt: async account => { calls.push(account); throw error; },
    })).rejects.toBe(error);
    expect(calls).toEqual([claude]);
    expect(availability.get(claude).status).toBe("available");
  });

  test("separate consumers share the default process registry", async () => {
    const account: ProviderAccount = { provider: "claude", accountId: "singleton-test" };
    try {
      await runWithProviderFallback({ priority: [account], attempt: async () => ({ status: "quota-blocked", refusal }) });
      expect(selectAvailableProvider([account])).toEqual({ status: "exhausted" });
      const result = await runWithProviderFallback({
        priority: [account], attempt: async (): Promise<never> => { throw new Error("must not run"); },
      });
      expect(result.status).toBe("exhausted");
    } finally {
      processProviderAvailability.clear(account);
    }
  });

  test("invalid attempt bounds fail before launching", async () => {
    for (const maxAttempts of [-1, 1.5, Infinity, NaN]) {
      await expect(runWithProviderFallback({
        priority: [claude], maxAttempts,
        attempt: async (): Promise<never> => { throw new Error("must not run"); },
      })).rejects.toThrow("maxAttempts");
    }
  });
});
