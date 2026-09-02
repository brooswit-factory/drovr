import { describe, expect, test } from "bun:test";
import { DrovrClient } from "../src/drovr-client.js";
import type { CallIdentity, ChokePoint } from "../src/choke-point.js";
import { buildFakeHerdrClient } from "./support/fake-herdr-client.js";
import { enumerateSurface } from "./support/enumerate-surface.js";

/**
 * Not DROVR-6 (the correction registry is explicitly out of scope here) --
 * this proves the seam DROVR-6 will hang off actually admits a registry:
 * every call's identity is visible, and both a normal result and a thrown
 * error can be observed or replaced from outside the choke point.
 */
describe("the choke point is a real seam for a future override registry", () => {
  test("a custom choke point sees every call's identity and can replace a result or recover from an error", async () => {
    const seen: CallIdentity[] = [];
    const { client } = buildFakeHerdrClient({
      resultFor: (call) => (call.method === "get" ? { real: true } : undefined),
      errorFor: (call) => (call.method === "focus" ? new Error("herdr said no") : undefined),
    });

    const overriding: ChokePoint = async (identity, invoke) => {
      seen.push(identity);
      if (identity.service === "agent" && identity.method === "list") return { overridden: true };
      try {
        return await invoke();
      } catch {
        return { recovered: true };
      }
    };

    const drovr = new DrovrClient({ herdr: client, chokePoint: overriding });

    expect(await (drovr.agent.list() as Promise<unknown>)).toEqual({ overridden: true });
    expect(await (drovr.agent.get("x") as Promise<unknown>)).toEqual({ real: true });
    expect(await (drovr.agent.focus("x") as Promise<unknown>)).toEqual({ recovered: true });

    expect(seen).toEqual([
      { service: "agent", method: "list", args: [] },
      { service: "agent", method: "get", args: ["x"] },
      { service: "agent", method: "focus", args: ["x"] },
    ]);
  });
});

/**
 * The test above proves the seam *works* for one service (`agent`) --
 * that a choke point can see a call's identity and replace its result or
 * recover from its error. It doesn't prove every service actually routes
 * through the seam; it never looks past `agent`, so a service left raw
 * by `wrapServices` (present, but not proxied) would still pass it.
 *
 * This block proves the second, distinct claim: every enumerated
 * {service, method} pair reaches the choke point at all. It reuses the
 * same runtime enumeration `test/parity.test.ts` uses (`enumerateSurface`,
 * lifted into `test/support/` so both tests share one definition instead
 * of two that could drift), so a service or method the SDK adds tomorrow
 * is covered automatically -- no name is hard-coded here.
 */
describe("every enumerated service method routes through the choke point", () => {
  test("a recording choke point observes every enumerated {service, method} pair", async () => {
    const { client } = buildFakeHerdrClient();
    const seen: CallIdentity[] = [];
    const recording: ChokePoint = async (identity, invoke) => {
      seen.push(identity);
      return invoke();
    };

    const drovr = new DrovrClient({ herdr: client, chokePoint: recording });
    const surface = enumerateSurface(client);
    expect(surface.length).toBeGreaterThan(0);

    for (const { service, method } of surface) {
      const drovrService = (drovr as unknown as Record<string, Record<string, unknown> | undefined>)[service];
      const fn = drovrService?.[method];
      await (fn as (...a: unknown[]) => Promise<unknown>).call(drovrService, { probe: true });
    }

    for (const { service, method } of surface) {
      expect(
        seen.some((identity) => identity.service === service && identity.method === method),
        `choke point never saw ${service}.${method} -- that service is bypassing the seam`,
      ).toBe(true);
    }
  });
});
