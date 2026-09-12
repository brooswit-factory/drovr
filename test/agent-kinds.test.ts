import { describe, expect, test } from "bun:test";
import { DrovrClient, HerdrError, type ParamsOf } from "../src/index.js";
import { buildFakeHerdrClient } from "./support/fake-herdr-client.js";

describe.each(["codex", "claude"] as const)("%s agent support", (kind) => {
  test("forwards typed startup options through service and wire calls unchanged", async () => {
    const started = { pane_id: "pane-test", kind };
    const { client, calls } = buildFakeHerdrClient({ resultFor: () => started });
    const drovr = new DrovrClient({ herdr: client });
    const options: ParamsOf<"agent.start"> = {
      name: `test-${kind}`,
      pane_id: "pane-test",
      kind,
      args: ["--model", "configured-model"],
      timeout_ms: 30_000,
    };

    expect<unknown>(await drovr.agent.start(options)).toBe(started);
    expect<unknown>(await drovr.call("agent.start", options)).toBe(started);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe("agent.start");
      expect(call.args[0]).toBe(options);
    }
    expect(options.args).toEqual(["--model", "configured-model"]);
  });

  test("uses the same prompt, status, and wait interface without provider-specific rewriting", async () => {
    const status = { agent_status: "idle", kind };
    const { client, calls } = buildFakeHerdrClient({ resultFor: () => status });
    const drovr = new DrovrClient({ herdr: client });
    const target = `test-${kind}`;
    const prompt: ParamsOf<"agent.prompt"> = { target, text: "test prompt" };
    const wait: ParamsOf<"agent.wait"> = { target, until: ["idle", "blocked"], timeout_ms: 1000 };

    expect<unknown>(await drovr.agent.prompt(prompt)).toBe(status);
    expect<unknown>(await drovr.agent.get(target)).toBe(status);
    expect<unknown>(await drovr.agent.wait(wait)).toBe(status);
    expect(calls.map(({ method, args }) => ({ method, args }))).toEqual([
      { method: "agent.prompt", args: [prompt] },
      { method: "agent.get", args: [{ target }] },
      { method: "agent.wait", args: [wait] },
    ]);
  });

  test("preserves startup failures without silently switching providers", async () => {
    const original = HerdrError.from("agent.start", { code: "internal", message: "agent unavailable" });
    const { client, calls } = buildFakeHerdrClient({ errorFor: () => original });
    const drovr = new DrovrClient({ herdr: client });
    let caught: unknown;
    try {
      await drovr.agent.start({ name: `test-${kind}`, pane_id: "pane-test", kind });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(calls).toHaveLength(1);
  });
});
