import { describe, expect, test } from "bun:test";
import {
  ResidentMessageRefusal,
  deliverToResident,
  type ChannelAck,
  type ResidentAgentTarget,
  type ResidentDeliveryDeps,
  type ResidentMessageResult,
} from "../src/index.js";

const TARGET: ResidentAgentTarget = {
  provider: "claude",
  sessionId: "5c72245c-4e0b-44cf-a5c1-b83a934a6783",
  cwd: "/home/brooswit/code/brooswit",
};

/** A resident whose transcript only ever grows when something is actually delivered. */
function fixture(options: { transcript?: string[]; refuse?: ResidentMessageRefusal; readFails?: boolean } = {}) {
  const woken: string[] = [];
  const transcript: string[] = [...(options.transcript ?? [])];
  const result: ResidentMessageResult = { status: "replied", reply: "ack" };
  let slept = 0;
  let clock = 0;
  const deps: ResidentDeliveryDeps = {
    messenger: {
      message: async (_target, text) => {
        if (options.refuse) throw options.refuse;
        woken.push(text);
        transcript.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
        return result;
      },
    },
    readTail: async (_target, offset) => {
      if (options.readFails) throw new Error("transcript unreadable");
      const whole = transcript.join("\n");
      return { offset: whole.length, text: whole.slice(offset) };
    },
    now: () => clock,
    sleep: async (ms) => { slept++; clock += ms; },
  };
  return { deps, woken, transcript, sleeps: () => slept };
}

const streamAck: ChannelAck = { delivered: true, proves: "stream", detail: { claim: "C2" } };

describe("a channel acknowledgement is evidence, not delivery", () => {
  test("REGRESSION: a delivered=true stream ack to an idle session wakes the resident", async () => {
    // The reported failure exactly: YAPPR answered delivered=true (claim C2 —
    // the stream took the frame), and the idle session never read it, because
    // nothing about an idle session drains its bridge or schedules a model.
    const f = fixture();
    const delivery = await deliverToResident(f.deps, TARGET, "the report", async () => streamAck, {
      observationTimeoutMs: 1_000, pollMs: 250,
    });

    expect(delivery.status).toBe("woken");
    if (delivery.status !== "woken") throw new Error("expected a wakeup");
    expect(delivery.ack).toEqual(streamAck);
    expect(delivery.result).toEqual({ status: "replied", reply: "ack" });
    // FALSIFIER: the whole bug is reporting the C2 ack as delivery and stopping here.
    expect(f.woken).toEqual(["the report"]);
  });

  test("the transcript is watched only until the deadline, then the resident is woken", async () => {
    const f = fixture();
    await deliverToResident(f.deps, TARGET, "the report", async () => streamAck, {
      observationTimeoutMs: 1_000, pollMs: 250,
    });
    // Bounded: it does not poll forever waiting for a message that never lands.
    expect(f.sleeps()).toBe(4);
  });

  test("a stream ack the transcript does confirm delivers without waking anything", async () => {
    const f = fixture();
    const delivery = await deliverToResident(f.deps, TARGET, "the report", async () => {
      f.transcript.push(JSON.stringify({ type: "user", message: { role: "user", content: "the report" } }));
      return streamAck;
    }, { observationTimeoutMs: 1_000, pollMs: 250 });

    expect(delivery.status).toBe("channel-observed");
    // FALSIFIER: waking here would duplicate a message the session already has.
    expect(f.woken).toEqual([]);
  });

  test("a channel that proves the session recorded it is trusted without a transcript read", async () => {
    const f = fixture({ readFails: true });
    const ack: ChannelAck = { delivered: true, proves: "session" };
    const delivery = await deliverToResident(f.deps, TARGET, "the report", async () => ack);

    expect(delivery).toEqual({ status: "channel-delivered", ack });
    expect(f.woken).toEqual([]);
  });

  test("an ack with no proof named is read as the weaker claim, never assumed away", async () => {
    const f = fixture();
    const delivery = await deliverToResident(f.deps, TARGET, "the report", async () => ({ delivered: true }), {
      observationTimeoutMs: 0,
    });
    expect(delivery.status).toBe("woken");
    expect(f.woken).toEqual(["the report"]);
  });

  test("a refused channel send goes straight to the resident, with no waiting", async () => {
    const f = fixture();
    const ack: ChannelAck = { delivered: false, detail: { reason: "no-channel-stream" } };
    const delivery = await deliverToResident(f.deps, TARGET, "the report", async () => ack);

    expect(delivery.status).toBe("woken");
    if (delivery.status === "woken") expect(delivery.ack).toEqual(ack);
    expect(f.sleeps()).toBe(0);
    expect(f.woken).toEqual(["the report"]);
  });

  test("an unreadable transcript is not read as confirmation", async () => {
    const f = fixture({ readFails: true });
    const delivery = await deliverToResident(f.deps, TARGET, "the report", async () => streamAck);
    expect(delivery.status).toBe("woken");
  });

  test("with no channel at all, the resident is simply woken", async () => {
    const f = fixture();
    const delivery = await deliverToResident(f.deps, TARGET, "the report");
    expect(delivery.status).toBe("woken");
    if (delivery.status === "woken") expect(delivery.ack).toBeUndefined();
  });

  test("a resident that cannot take the wakeup is reported undelivered, never as delivered", async () => {
    const refusal = new ResidentMessageRefusal("busy", "The resident is mid-turn");
    const f = fixture({ refuse: refusal });
    const delivery = await deliverToResident(f.deps, TARGET, "the report", async () => streamAck, {
      observationTimeoutMs: 0,
    });

    expect(delivery.status).toBe("undelivered");
    if (delivery.status !== "undelivered") throw new Error("expected undelivered");
    expect(delivery.reason).toBe(refusal);
    expect(delivery.ack).toEqual(streamAck);
  });
});
