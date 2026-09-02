import { describe, expect, test } from "bun:test";
import { HerdrError, isTimeout } from "@brooswit/herdr-sdk";
import { DrovrClient } from "../src/drovr-client.js";
import { defaultCorrections, type CorrectionRegistry } from "../src/corrections.js";
import { buildFakeHerdrClient } from "./support/fake-herdr-client.js";

/**
 * DROVR-6: the per-wire-method correction registry applied at the choke
 * point. See docs/correction-seam.md for the design writeup this exercises;
 * the four numbered properties below are §4 of DROVR-10/DROVR-6.
 */
describe("correction registry", () => {
  // Property 1: identity is the default.
  test("a method with no matching registry entry returns herdr's result untouched, by reference, even when other methods ARE corrected", async () => {
    const sentinel = { id: "sentinel" };
    const { client } = buildFakeHerdrClient({ resultFor: () => sentinel });
    const registry: CorrectionRegistry = {
      "agent.get": (result) => result,
    };
    const drovr = new DrovrClient({ herdr: client, corrections: registry });

    expect(await (drovr.agent.list() as Promise<unknown>)).toBe(sentinel);
  });

  // Property 2 (result side): a registration actually changes what the
  // consumer sees.
  test("a registered correction changes the result the consumer sees", async () => {
    const { client } = buildFakeHerdrClient({ resultFor: () => ({ agents: [] }) });
    const registry: CorrectionRegistry = {
      "agent.list": (result) => ({ ...(result as Record<string, unknown>), corrected: true }) as never,
    };
    const drovr = new DrovrClient({ herdr: client, corrections: registry });

    expect(await (drovr.agent.list() as Promise<unknown>)).toEqual({ agents: [], corrected: true });
  });

  // Property 2 (the hole from §5): one registration must catch BOTH routes
  // to the same wire method -- the service-method call and the call()
  // escape hatch. Keying on the JS method name instead of the wire name
  // would correct one and silently miss the other; this is the test that
  // would catch that regression.
  test("one registration corrects both the service-method route and the call() route for the same wire method", async () => {
    const { client } = buildFakeHerdrClient({
      resultFor: (call) => ({ service: call.service, method: call.method }),
    });
    const registry: CorrectionRegistry = {
      "agent.send_keys": (result) => ({ ...(result as Record<string, unknown>), corrected: true }) as never,
    };
    const drovr = new DrovrClient({ herdr: client, corrections: registry });

    const viaService = await (drovr.agent.sendKeys({ target: "p1", keys: ["a"] } as never) as Promise<unknown>);
    const viaCall = await (drovr.call("agent.send_keys" as never, { target: "p1", keys: ["a"] } as never) as Promise<
      unknown
    >);

    expect(viaService).toEqual({ service: "agent", method: "agent.send_keys", corrected: true });
    expect(viaCall).toEqual({ service: "client", method: "agent.send_keys", corrected: true });
  });

  // Property 3: a correction may be async and call back into herdr via
  // ctx.client, using the answer.
  test("a correction can await another herdr call via ctx.client and use its answer", async () => {
    const { client } = buildFakeHerdrClient({
      resultFor: (call) => (call.method === "agent.get" ? { real: "get-result" } : { agents: [] }),
    });
    const registry: CorrectionRegistry = {
      "agent.list": async (result, ctx) => {
        const detail = await ctx.client.agent.get("probe-target" as never);
        return { ...(result as Record<string, unknown>), detail } as never;
      },
    };
    const drovr = new DrovrClient({ herdr: client, corrections: registry });

    expect(await (drovr.agent.list() as Promise<unknown>)).toEqual({
      agents: [],
      detail: { real: "get-result" },
    });
  });

  // Property 3 (the recursion guard): a correction calling back into its
  // OWN method via ctx.client must terminate, not recurse forever. ctx.client
  // is the raw hatch (never the corrected client), so the callback never
  // re-enters any corrector.
  test("a correction calling back into its own method via ctx.client terminates instead of recursing forever", async () => {
    const { client, calls } = buildFakeHerdrClient({ resultFor: () => ({ agents: [] }) });
    const registry: CorrectionRegistry = {
      "agent.list": async (result, ctx) => {
        const again = (await ctx.client.agent.list()) as { agents: unknown[] };
        return { ...(result as Record<string, unknown>), reentered: again.agents } as never;
      },
    };
    const drovr = new DrovrClient({ herdr: client, corrections: registry });

    const result = await (drovr.agent.list() as Promise<unknown>);

    expect(result).toEqual({ agents: [], reentered: [] });
    // Exactly two real calls reached the inner client: the original, plus
    // the one the correction made via ctx.client. If ctx.client re-entered
    // the corrector, this would grow without bound (or hang) instead.
    expect(calls.filter((c) => c.service === "agent" && c.method === "agent.list").length).toBe(2);
  });

  // Property 4: raw bypasses the registry entirely.
  test("the raw hatch returns the uncorrected result even when a correction is registered for that method", async () => {
    const sentinel = { agents: [] };
    const { client } = buildFakeHerdrClient({ resultFor: () => sentinel });
    const registry: CorrectionRegistry = {
      "agent.list": (result) => ({ ...(result as Record<string, unknown>), corrected: true }) as never,
    };
    const drovr = new DrovrClient({ herdr: client, corrections: registry });

    expect(await (drovr.agent.list() as Promise<unknown>)).toEqual({ agents: [], corrected: true });
    expect(await (drovr.raw.agent.list() as Promise<unknown>)).toBe(sentinel);
  });

  // The uncorrected path must keep DROVR-5's error-propagation guarantee
  // even when routed through the correction-registry choke point (not just
  // passThroughChokePoint, which test/pass-through.test.ts already covers).
  test("the uncorrected path still propagates a thrown HerdrError as the same instance, isTimeout intact", async () => {
    const original = HerdrError.from("agent.wait", { code: "timeout", message: "no response in time" });
    const { client } = buildFakeHerdrClient({ errorFor: () => original });
    const registry: CorrectionRegistry = {
      // An unrelated entry -- proves this holds because "agent.wait" has no
      // matching entry, not because the registry happens to be empty.
      "agent.get": (result) => result,
    };
    const drovr = new DrovrClient({ herdr: client, corrections: registry });

    let caught: unknown;
    try {
      await drovr.agent.wait({ target: "x" } as never);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(original);
    expect(caught).toBeInstanceOf(HerdrError);
    expect(isTimeout(caught)).toBe(true);
  });

  // The registry ships empty: behaviour with the real, shipped default is
  // identical to plain pass-through -- for the one method this exercises.
  // On its own this is NOT a guarantee that the shipped registry is empty:
  // a correction registered on any OTHER method would sail straight
  // through this test undetected. See the dedicated assertion below, which
  // reads `defaultCorrections` directly instead of spot-checking behaviour
  // through a single method.
  test("the default (empty) registry changes no behaviour for agent.list", async () => {
    const sentinel = { agents: [] };
    const { client } = buildFakeHerdrClient({ resultFor: () => sentinel });
    const drovr = new DrovrClient({ herdr: client });

    expect(await (drovr.agent.list() as Promise<unknown>)).toBe(sentinel);
  });

  // THE blocking guarantee: the registry this epic ships genuinely has no
  // entries, checked by reading the shipped object rather than by spot-
  // checking one method's behaviour. A correction registered on ANY wire
  // method -- not just the one or two a behavioural test happens to probe
  // -- fails this and names the offending key(s), because a behavioural
  // test that only exercises "agent.list" cannot see a correction smuggled
  // in on "server.ping" or any other of the ~91 methods. This is the
  // property the epic said would be checked hardest: "this epic changed no
  // behaviour" rests entirely on this registry being empty.
  test("the shipped default registry has no entries", () => {
    const smuggledKeys = Object.keys(defaultCorrections);
    expect(smuggledKeys, `defaultCorrections must ship empty -- found: ${smuggledKeys.join(", ")}`).toEqual([]);
  });
});
