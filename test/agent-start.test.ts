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
    options: { now: () => time, wait: async (ms: number) => { waits.push(ms); time += ms; } },
  };
}

describe("bounded managed agent start", () => {
  test("returns the first successful launch unchanged without readiness heuristics or another attempt", async () => {
    const f = fixture(async () => success);
    expect(await startManagedAgent(f.client, launch, f.options)).toBe(success);
    expect(f.calls).toEqual([launch]);
    expect(f.waits).toEqual([]);
    expect(f.reads()).toBe(0);
  });

  test("startup helpers taking longer than the former one-second budget can settle", async () => {
    let attempts = 0;
    const f = fixture(async () => { if (++attempts <= 7) throw busy(); return success; });
    expect(await startManagedAgent(f.client, launch, f.options)).toBe(success);
    expect(f.calls).toHaveLength(8);
    expect(f.calls.every((p) => p === launch)).toBe(true);
    expect(f.waits.reduce((a, b) => a + b, 0)).toBe(1400);
    expect(f.reads()).toBe(0);
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
    expect(f.reads()).toBe(1);
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
      expect(f.reads()).toBe(0);
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
      expect(f.calls).toEqual([]);
    }
  });
});
