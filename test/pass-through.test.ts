import { describe, expect, test } from "bun:test";
import { HerdrError, isTimeout } from "@brooswit/herdr-sdk";
import { DrovrClient } from "../src/drovr-client.js";
import { buildFakeHerdrClient } from "./support/fake-herdr-client.js";

describe("DrovrClient pass-through", () => {
  test("a service method's result comes back as the exact object herdr returned, not a copy", async () => {
    const sentinel = { id: "sentinel" };
    const { client } = buildFakeHerdrClient({ resultFor: () => sentinel });
    const drovr = new DrovrClient({ herdr: client });

    expect(await (drovr.agent.list() as Promise<unknown>)).toBe(sentinel);
  });

  test("a HerdrError thrown by herdr arrives at the consumer as that same instance", async () => {
    const original = HerdrError.from("agent.get", { code: "not_found", message: "no such agent" });
    const { client } = buildFakeHerdrClient({ errorFor: () => original });
    const drovr = new DrovrClient({ herdr: client });

    let caught: unknown;
    try {
      await drovr.agent.get("nope");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(original);
    expect(caught).toBeInstanceOf(HerdrError);
    expect(isTimeout(caught)).toBe(false);
  });

  test("isTimeout still recognizes a timeout-shaped HerdrError after it passes through DrovrClient", async () => {
    const timeoutError = HerdrError.from("agent.wait", { code: "timeout", message: "no response in time" });
    const { client } = buildFakeHerdrClient({ errorFor: () => timeoutError });
    const drovr = new DrovrClient({ herdr: client });

    let caught: unknown;
    try {
      await drovr.agent.wait({ target: "x" } as never);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(timeoutError);
    expect(isTimeout(caught)).toBe(true);
  });

  test("call() propagates both a result and an error identically", async () => {
    const sentinel = { ok: true };
    const okFake = buildFakeHerdrClient({ resultFor: () => sentinel });
    const okDrovr = new DrovrClient({ herdr: okFake.client });
    expect(await (okDrovr.call("agent.list" as never, {} as never) as Promise<unknown>)).toBe(sentinel);

    const original = HerdrError.from("agent.list", { code: "internal", message: "boom" });
    const errFake = buildFakeHerdrClient({ errorFor: () => original });
    const errDrovr = new DrovrClient({ herdr: errFake.client });

    let caught: unknown;
    try {
      await errDrovr.call("agent.list" as never, {} as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });
});
