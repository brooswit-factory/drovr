import { describe, expect, test } from "bun:test";
import { HerdrClient } from "@brooswit/herdr-sdk";
import { DrovrClient } from "../src/drovr-client.js";
import { buildFakeHerdrClient } from "./support/fake-herdr-client.js";
import { enumerateSurface } from "./support/enumerate-surface.js";

describe("DrovrClient parity with HerdrClient", () => {
  test("sanity: the SDK currently exposes 91 methods across 12 services", () => {
    const surface = enumerateSurface(new HerdrClient({ socketPath: "/dev/null/drovr-test-unused.sock" }));
    expect(new Set(surface.map((c) => c.service)).size).toBe(12);
    expect(surface.length).toBe(91);
  });

  test("every enumerated service method is reachable and callable through DrovrClient, and reaches the inner client", async () => {
    const { client, calls } = buildFakeHerdrClient();
    const drovr = new DrovrClient({ herdr: client });
    const surface = enumerateSurface(client);
    expect(surface.length).toBeGreaterThan(0);

    for (const { service, method } of surface) {
      const drovrService = (drovr as unknown as Record<string, Record<string, unknown> | undefined>)[service];
      const fn = drovrService?.[method];
      expect(fn, `DrovrClient.${service}.${method} is not callable`).toBeFunction();
      await (fn as (...a: unknown[]) => Promise<unknown>).call(drovrService, { probe: true });
    }

    expect(calls.length).toBe(surface.length);
    for (const { service, method } of surface) {
      expect(
        calls.some((c) => c.service === service && c.method === method),
        `inner client never saw ${service}.${method}`,
      ).toBe(true);
    }
  });

  test("call() reaches the inner client with the method name and params intact", async () => {
    const { client, calls } = buildFakeHerdrClient();
    const drovr = new DrovrClient({ herdr: client });

    await drovr.call("agent.list" as never, {} as never);

    expect(calls).toEqual([{ service: "client", method: "agent.list", args: [{}] }]);
  });
});
