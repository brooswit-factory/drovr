import { describe, expect, test } from "bun:test";
import { DrovrClient } from "../src/drovr-client.js";
import type { CallIdentity, ChokePoint } from "../src/choke-point.js";
import { buildFakeHerdrClient } from "./support/fake-herdr-client.js";

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
