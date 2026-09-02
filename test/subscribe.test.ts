import { describe, expect, test } from "bun:test";
import type { HerdrClient, Subscription } from "@brooswit/herdr-sdk";
import { DrovrClient } from "../src/drovr-client.js";

describe("DrovrClient.subscribe", () => {
  test("passes through to the inner client's subscribe, returning the same Subscription instance, iteration, and close()", async () => {
    let closed = false;
    let receivedSubscriptions: unknown;

    const sentinelSubscription = {
      [Symbol.asyncIterator]: async function* () {
        yield { event: "agent", data: { hello: "world" } };
      },
      close: () => {
        closed = true;
      },
    } as unknown as Subscription;

    const fake = {
      opts: { socketPath: "/dev/null/drovr-test-unused.sock" },
      subscribe: async (subscriptions: unknown) => {
        receivedSubscriptions = subscriptions;
        return sentinelSubscription;
      },
    } as unknown as HerdrClient;

    const drovr = new DrovrClient({ herdr: fake });
    const subscription = await drovr.subscribe([{ kind: "agent" } as never]);

    expect(subscription).toBe(sentinelSubscription);
    expect(receivedSubscriptions).toEqual([{ kind: "agent" }]);

    const yielded: unknown[] = [];
    for await (const frame of subscription) yielded.push(frame);
    expect(yielded).toEqual([{ event: "agent", data: { hello: "world" } }]);

    subscription.close();
    expect(closed).toBe(true);
  });
});
