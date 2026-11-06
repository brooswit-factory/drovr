import { describe, expect, test } from "bun:test";
import { HerdrError, type ResultOf } from "@brooswit/herdr-sdk";
import { AgentShellReadinessError, startManagedAgent } from "../src/agent-start.js";

const params = { name: "test", pane_id: "w1:p1", kind: "claude", args: ["secret-argument"], timeout_ms: 30_000 } as const;
const launch = { ...params, args: [...params.args] };
const success = { type: "agent_started" } as ResultOf<"agent.start">;
const serverError = (code: string, message: string) => HerdrError.from("agent.start", { code, message });
const busy = () => serverError("agent_pane_busy", "secret-server-message");

function fixture(start: () => Promise<ResultOf<"agent.start">>) {
  let time = 0;
  const calls: unknown[] = [], waits: number[] = [];
  let reads = 0;
  const client = {
    agent: { start: async (p: unknown) => { calls.push(p); return start(); } },
    pane: { processInfo: async () => {
      reads++;
      return { type: "pane_process_info" as const, process_info: {
        pane_id: "w1:p1", shell_pid: 10, foreground_process_group_id: 10,
        foreground_processes: [{ pid: 10, name: "fish", argv: ["secret"] }, { pid: 11, name: "secret-name", cmdline: "secret-command", cwd: "secret-path" }],
      } };
    } },
  };
  return {
    client, calls, waits, reads: () => reads, advance: (ms: number) => { time += ms; },
    // Deterministic "already left canonical mode" default -- the common
    // case this whole module existed to handle before FACTORY-1037 (an
    // already-ready pane). Individual canonical-mode-gate tests override
    // this explicitly; every other test here is about the UNCHANGED
    // busy-retry behavior and must never depend on a real /proc + stty read.
    options: { now: () => time, wait: async (ms: number) => { waits.push(ms); time += ms; }, checkCanonicalMode: async () => "raw" as const },
  };
}

describe("bounded managed agent start", () => {
  test("returns the first successful launch unchanged without readiness heuristics or another attempt", async () => {
    const f = fixture(async () => success);
    expect(await startManagedAgent(f.client, launch, f.options)).toBe(success);
    expect(f.calls).toEqual([launch]);
    expect(f.waits).toEqual([]);
    // One read: the canonical-mode gate's own single pre-flight check.
    expect(f.reads()).toBe(1);
  });

  test("startup helpers taking longer than the former one-second budget can settle", async () => {
    let attempts = 0;
    const f = fixture(async () => { if (++attempts <= 7) throw busy(); return success; });
    expect(await startManagedAgent(f.client, launch, f.options)).toBe(success);
    expect(f.calls).toHaveLength(8);
    expect(f.calls.every((p) => p === launch)).toBe(true);
    expect(f.waits.reduce((a, b) => a + b, 0)).toBe(1400);
    expect(f.reads()).toBe(1);
  });

  test("deadline caps retries and final wait; diagnostic data cannot expose secret fields", async () => {
    const f = fixture(async () => { throw busy(); });
    let caught: unknown;
    try { await startManagedAgent(f.client, launch, { ...f.options, readinessTimeoutMs: 500 }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AgentShellReadinessError);
    const error = caught as AgentShellReadinessError;
    expect(error.diagnostics).toEqual({ attempts: 3, elapsedMs: 500, processInfo: "available", shellPid: 10, foregroundProcessGroupId: 10, foregroundProcessCount: 2, otherForegroundProcessCount: 1 });
    expect(f.waits).toEqual([200, 200, 100]);
    // Two reads: the gate's own pre-flight check, plus diagnose()'s on exhaustion.
    expect(f.reads()).toBe(2);
    expect(error.message + JSON.stringify(error)).not.toContain("secret");
  });

  test("a slow busy response consumes the readiness budget without another attempt", async () => {
    const f = fixture(async () => { f.advance(600); throw busy(); });
    await expect(startManagedAgent(f.client, launch, { ...f.options, readinessTimeoutMs: 500 })).rejects.toBeInstanceOf(AgentShellReadinessError);
    expect(f.calls).toHaveLength(1);
    expect(f.waits).toEqual([]);
  });

  test("does not race an in-flight successful launch against the readiness deadline", async () => {
    const f = fixture(async () => { f.advance(20_000); return success; });
    expect(await startManagedAgent(f.client, launch, f.options)).toBe(success);
    expect(f.calls).toHaveLength(1);
  });

  test("all uncertain, configuration and quota errors propagate unchanged", async () => {
    for (const error of [new Error("agent_pane_busy"), { code: "agent_pane_busy" }, serverError("agent_not_ready", "blocked"), serverError("timeout", "unknown launch outcome"), serverError("invalid_agent_kind", "bad config"), new Error("quota exhausted")]) {
      const f = fixture(async () => { throw error; });
      await expect(startManagedAgent(f.client, launch, f.options)).rejects.toBe(error);
      expect(f.calls).toHaveLength(1);
      expect(f.waits).toEqual([]);
      expect(f.reads()).toBe(1);
    }
  });

  test("a non-busy error after busy is still terminal", async () => {
    const error = serverError("agent_not_ready", "startup dialog");
    let calls = 0;
    const f = fixture(async () => { throw ++calls === 1 ? busy() : error; });
    await expect(startManagedAgent(f.client, launch, f.options)).rejects.toBe(error);
    expect(f.calls).toHaveLength(2);
  });

  test("hung or failed diagnostic reads do not hide the bounded readiness error", async () => {
    for (const read of [async () => { throw new Error("secret"); }, () => new Promise<never>(() => {})]) {
      const f = fixture(async () => { throw busy(); });
      f.client.pane.processInfo = read;
      let caught: unknown;
      try { await startManagedAgent(f.client, launch, { ...f.options, readinessTimeoutMs: 1, diagnosticWait: async () => {} }); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AgentShellReadinessError);
      expect((caught as AgentShellReadinessError).diagnostics.processInfo).toBe("unavailable");
    }
  });

  test("invalid retry budgets are rejected before launch", async () => {
    for (const value of [0, -1, NaN, Infinity]) {
      const f = fixture(async () => success);
      await expect(startManagedAgent(f.client, launch, { readinessTimeoutMs: value })).rejects.toBeInstanceOf(RangeError);
      await expect(startManagedAgent(f.client, launch, { retryIntervalMs: value })).rejects.toBeInstanceOf(RangeError);
      await expect(startManagedAgent(f.client, launch, { canonicalModeTimeoutMs: value })).rejects.toBeInstanceOf(RangeError);
      expect(f.calls).toEqual([]);
    }
  });
});

describe("canonical-mode readiness gate (FACTORY-1037)", () => {
  // Incident mechanism, reproduced in isolation and live against a real
  // herdr with a deliberately slow shell startup: a pane can report "no
  // foreground child, just the shell" (herdr's own busy check passes)
  // before the shell has actually left kernel canonical TTY mode, in which
  // case any single injected line over the kernel's 4096-byte canonical
  // limit is silently capped with no error and no terminating newline --
  // the command never submits. These pin the gate that gives agent.start a
  // GROUND-TRUTH readiness signal (checkCanonicalMode) instead of trusting
  // a bare foreground-process check.

  test("never calls agent.start while the shell is confirmed still canonical, even once", async () => {
    const f = fixture(async () => success);
    const checked: number[] = [];
    const caught = await startManagedAgent(f.client, launch, {
      ...f.options, canonicalModeTimeoutMs: 50, retryIntervalMs: 5,
      checkCanonicalMode: async (shellPid) => { checked.push(shellPid); return "canonical"; },
    }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("agent_terminal_canonical_mode_timeout");
    expect((caught as { paneId?: string }).paneId).toBe("w1:p1");
    // Zero injection attempts -- exactly-once launch semantics hold trivially: nothing launched at all.
    expect(f.calls).toEqual([]);
    expect(checked.every((pid) => pid === 10)).toBe(true);
    expect(checked.length).toBeGreaterThan(1); // actually polled, not a single check
  });

  test("a pane that leaves canonical mode partway through the bound proceeds, with full argv preserved", async () => {
    const f = fixture(async () => success);
    let calls = 0;
    const paddedArg = "p".repeat(5970) + "_🙂_" + "'; echo not-injected #";
    const longLaunch = { ...launch, args: [paddedArg] };
    const result = await startManagedAgent(f.client, longLaunch, {
      ...f.options, canonicalModeTimeoutMs: 1_000, retryIntervalMs: 1,
      checkCanonicalMode: async () => (++calls <= 3 ? "canonical" : "raw"),
    });
    expect(result).toBe(success);
    expect(calls).toBe(4);
    expect(f.calls).toEqual([longLaunch]);
    expect((f.calls[0] as { args: string[] }).args[0]).toBe(paddedArg); // byte-for-byte, not re-quoted or mangled
  });

  test("an unavailable readiness check (unsupported shell / cannot verify) degrades to proceeding immediately, never refusing", async () => {
    const f = fixture(async () => success);
    let checks = 0;
    const result = await startManagedAgent(f.client, launch, {
      ...f.options, checkCanonicalMode: async () => { checks++; return "unavailable"; },
    });
    expect(result).toBe(success);
    expect(checks).toBe(1); // checked once, accepted "unavailable" immediately -- no polling loop entered
    expect(f.calls).toEqual([launch]);
  });

  test("no shell_pid yet (interrupted/uncertain startup) also proceeds without ever calling the readiness check", async () => {
    const f = fixture(async () => success);
    f.client.pane.processInfo = (async () => ({ type: "pane_process_info" as const, process_info: { pane_id: "w1:p1" } })) as typeof f.client.pane.processInfo;
    let checked = false;
    const result = await startManagedAgent(f.client, launch, { ...f.options, checkCanonicalMode: async () => { checked = true; return "canonical"; } });
    expect(result).toBe(success);
    expect(checked).toBe(false);
  });

  test("the gate itself never retries agent.start -- busy-retry afterward is unaffected and still exactly matches pre-FACTORY-1037 behavior", async () => {
    let attempts = 0;
    const f = fixture(async () => { if (++attempts <= 2) throw busy(); return success; });
    const result = await startManagedAgent(f.client, launch, f.options);
    expect(result).toBe(success);
    expect(f.calls).toHaveLength(3);
    expect(f.calls.every((p) => p === launch)).toBe(true); // no duplicate/mutated argv across retries
  });

  // The ticket's own measured boundary: Linux MAX_CANON is 4096 bytes: a
  // line AT 4095 or below fits inside a single canonical-mode read, 4096
  // lands exactly on it, and 4097+ is where the kernel silently drops the
  // remainder with no error (reproduced in isolation; see the PR). None of
  // these sizes should matter to THIS gate -- it acts on the shell's TTY
  // mode, not on measuring argv length -- which is itself worth pinning:
  // the gate must preserve the exact arg, unmangled, at every size.
  for (const size of [4095, 4096, 4097, 6001]) {
    test(`a ${size}-byte argument is preserved byte-for-byte once the gate clears`, async () => {
      const f = fixture(async () => success);
      const arg = "b".repeat(size);
      const sized = { ...launch, args: [arg] };
      let polls = 0;
      const result = await startManagedAgent(f.client, sized, {
        ...f.options, retryIntervalMs: 1,
        checkCanonicalMode: async () => (++polls <= 2 ? "canonical" : "raw"),
      });
      expect(result).toBe(success);
      expect(f.calls).toEqual([sized]);
      const sentArg = (f.calls[0] as { args: string[] }).args[0]!;
      expect(sentArg.length).toBe(size);
      expect(sentArg).toBe(arg);
    });
  }
});
