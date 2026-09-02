import { describe, expect, test } from "bun:test";
import { passThroughChokePoint } from "../src/choke-point.js";

describe("passThroughChokePoint", () => {
  test("forwards to invoke() and returns its result unchanged, by reference", async () => {
    const sentinel = { x: 1 };
    const result = await passThroughChokePoint({ service: "agent", method: "list", args: [] }, async () => sentinel);
    expect(result).toBe(sentinel);
  });

  test("propagates a thrown error from invoke() unchanged, by reference", async () => {
    const original = new Error("boom");
    let caught: unknown;
    try {
      await passThroughChokePoint({ service: "agent", method: "list", args: [] }, async () => {
        throw original;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });
});
