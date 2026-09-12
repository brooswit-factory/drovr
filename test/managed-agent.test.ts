import { describe, expect, test } from "bun:test";
import { DrovrClient, promptManagedAgent, resolveManagedAgent, type results } from "../src/index.js";
import { buildFakeHerdrClient } from "./support/fake-herdr-client.js";

const identity = { cwd: "/work/KAN-42", provider: "codex" as const };
const agent = (patch: Partial<results.AgentInfo> = {}): results.AgentInfo => ({
  agent: "codex",
  agent_status: "idle",
  cwd: "/work/KAN-42",
  focused: false,
  name: "butchr-kan-42",
  pane_id: "w1:p2",
  revision: 1,
  tab_id: "w1:t1",
  terminal_id: "terminal-1",
  workspace_id: "w1",
  ...patch,
});

function clientWith(agents: results.AgentInfo[]) {
  const fake = buildFakeHerdrClient({
    resultFor: (call) => call.method === "agent.list"
      ? { type: "agent_list", agents }
      : { type: "agent_prompted", agent: agents.find((a) => a.pane_id === (call.args[0] as { target: string }).target)! },
  });
  return { client: new DrovrClient({ herdr: fake.client }), calls: fake.calls };
}

describe("managed agent identity", () => {
  test("prefers a persisted pane handle", async () => {
    const expected = agent({ name: null });
    const { client } = clientWith([expected]);
    const result = await resolveManagedAgent(client, { ...identity, paneId: expected.pane_id });
    expect(result).toEqual({ status: "found", matchedBy: "pane", agent: expected });
  });

  test("recovers an agent whose friendly name was cleared", async () => {
    const expected = agent({ name: null });
    const { client, calls } = clientWith([expected]);
    const result = await promptManagedAgent(client, identity, "continue");
    expect(result.resolution.status).toBe("found");
    if (result.resolution.status === "found") expect(result.resolution.matchedBy).toBe("workspace");
    expect(calls).toContainEqual({ service: "agent", method: "agent.prompt", args: [{ target: "w1:p2", text: "continue" }] });
  });

  test("does not recover across providers", async () => {
    const { client } = clientWith([agent({ agent: "claude", name: null })]);
    expect((await resolveManagedAgent(client, identity)).status).toBe("missing");
  });

  test("resolves existing work across a configured provider switch", async () => {
    const expected = agent({ agent: "claude", name: null });
    const { client } = clientWith([expected]);
    const result = await resolveManagedAgent(client, { cwd: identity.cwd });
    expect(result).toEqual({ status: "found", matchedBy: "workspace", agent: expected });
  });

  test("refuses an ambiguous workspace instead of prompting", async () => {
    const { client, calls } = clientWith([agent({ name: null }), agent({ name: null, pane_id: "w1:p3" })]);
    const result = await promptManagedAgent(client, identity, "continue");
    expect(result.resolution.status).toBe("ambiguous");
    expect(calls.filter((call) => call.method === "agent.prompt")).toHaveLength(0);
  });

  test("does not trust a matching alias in another workspace", async () => {
    const { client } = clientWith([agent({ cwd: "/work/OTHER" })]);
    expect((await resolveManagedAgent(client, identity)).status).toBe("missing");
  });
});
