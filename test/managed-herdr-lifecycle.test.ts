import { describe, expect, test } from "bun:test";
import type { DrovrClient } from "../src/drovr-client.js";
import { ManagedHerdrLifecycle, type ManagedHerdrStartRequest } from "../src/managed-herdr-lifecycle.js";
import { ProviderAvailabilityRegistry } from "../src/provider-fallback.js";
import type { ManagedAgentProvider } from "../src/agent-runtime.js";

function fixture(options: { readFail?: boolean; startFail?: boolean; ack?: "missing" | "empty" | "prompt"; closeFail?: boolean; kickoffFail?: boolean; provider?: ManagedAgentProvider; large?: boolean; fastDone?: boolean; disappear?: boolean; slowRead?: boolean } = {}) {
  const events: string[] = [];
  const source = options.large ? "history".repeat(15_000) : "saved history with pending work";
  const histories = new Map<string, string>([["old", source]]);
  const row = (pane: string, provider: ManagedAgentProvider) => ({ pane_id: pane, cwd: "/work", agent: provider, agent_status: "idle", agent_session: { agent: provider, kind: "id", value: pane, source: "test" } });
  let rows = [row("old", "claude")];
  let count = 0;
  const prompts: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  function respond(pane: string, prompt: string, provider: ManagedAgentProvider) {
    prompts.push(prompt);
    const token = prompt.match(/DROVR_HANDOFF_READY_[a-f0-9-]+/)?.[0];
    if (!token) return;
    const response = options.ack === "empty" ? token : options.ack === "missing" ? "unacknowledged summary" : `${token}\nObjectives, decisions, remaining work.`;
    const text = options.ack === "prompt" ? prompt : response;
    const record = provider === "claude"
      ? { type: options.ack === "prompt" ? "user" : "assistant", message: { role: options.ack === "prompt" ? "user" : "assistant", content: [{ type: "text", text }] } }
      : provider === "codex"
        ? { type: "response_item", payload: { type: "message", role: options.ack === "prompt" ? "user" : "assistant", content: [{ type: "output_text", text }] } }
      : { type: options.ack === "prompt" ? "USER_INPUT" : "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: text };
    histories.set(pane, (histories.get(pane) ?? "") + JSON.stringify(record) + "\n");
  }
  const client = {
    agent: {
      list: async () => ({ agents: rows }),
      get: async (pane: string) => { events.push(`get:${pane}`); return { agent: rows.find(a => a.pane_id === pane)! }; },
      start: async (params: any) => {
        events.push(`start:${params.pane_id}`);
        if (params.args.some((arg: string) => arg.includes("\n"))) throw new Error("Herdr cannot encode multiline launch arguments");
        if (options.startFail) throw new Error("start failed");
        rows.push(row(params.pane_id, params.kind));
        await gate;
        respond(params.pane_id, params.args[params.kind === "agy" ? 1 : 0], params.kind);
      },
      prompt: async ({ target, text }: any) => {
        events.push(`prompt:${target}:${text === "kickoff" ? "kickoff" : "other"}`);
        if (text === "kickoff" && options.kickoffFail) throw new Error("kickoff failed");
        const agent = rows.find(a => a.pane_id === target)!;
        respond(target, text, agent.agent);
        if (text === "kickoff") agent.agent_status = options.fastDone ? "done" : "working";
        if (text === "kickoff" && options.disappear) rows = rows.filter(a => a.pane_id !== target);
        return { agent };
      },
    },
    workspace: { create: async () => { events.push("create"); return { root_pane: `new-${++count}` }; } },
    pane: {
      close: async (pane: string) => {
        events.push(`close:${pane}`);
        if (options.closeFail && pane === "old") throw new Error("close failed");
        rows = rows.filter(a => a.pane_id !== pane);
      },
      read: async () => { throw new Error("Screen must never be read for history or ack"); },
    },
  };
  const lifecycle = new ManagedHerdrLifecycle({ client: client as unknown as DrovrClient, cwd: "/work", availability: new ProviderAvailabilityRegistry(), wait: async () => {}, pollIntervalMs: 1, acknowledgementTimeoutMs: options.slowRead ? 2 : 100,
    readTranscript: async ({ session }) => {
      events.push(`read:${session.value}`);
      if (options.readFail && session.value === "old") throw new Error("missing transcript");
      if (options.slowRead && session.value !== "old") return new Promise<string>(() => {});
      return histories.get(session.value) ?? "";
    },
  });
  const provider = options.provider ?? "codex";
  const request: ManagedHerdrStartRequest = { priority: [{ provider, accountId: "default" }], label: "role", replacePaneId: "old", kickoff: () => "kickoff", prepare: async provider => {
    events.push("prepare");
    return { launch: provider === "claude"
      ? { provider, cwd: "/work", name: "role", paneId: "ignored", prompt: "must not launch", effort: "high", mcpConfigPath: "/work/mcp.json" }
      : provider === "codex" ? { provider, cwd: "/work", name: "role", paneId: "ignored", prompt: "must not launch", mcpServers: [] }
      : { provider, cwd: "/work", name: "role", paneId: "ignored", prompt: "must not launch" } };
  } };
  return { lifecycle, client: client as unknown as DrovrClient, request, events, prompts, histories, rows: () => rows, gate: (value: Promise<void>) => { gate = value; } };
}

describe("ManagedHerdrLifecycle", () => {
  test("explicit kickoff runs exactly once even when it finishes before verification", async () => {
    const f = fixture({ fastDone: true });
    expect((await f.lifecycle.start(f.request)).status).toBe("success");
    expect(f.events.filter(e => e.endsWith(":kickoff"))).toEqual(["prompt:new-1:kickoff"]);
  });
  test("disappearance during final verification is blocked, never success", async () => {
    const f = fixture({ disappear: true });
    expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
    expect(f.lifecycle.current?.paneId).toBe("new-1");
  });
  test("a hung native acknowledgement read is bounded by wall time", async () => {
    const f = fixture({ slowRead: true });
    expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
    expect(f.lifecycle.current?.paneId).toBe("old");
    expect(f.events).not.toContain("close:old");
  });
  test("instances sharing client and workspace serialize replacement operations", async () => {
    const f = fixture();
    const second = new ManagedHerdrLifecycle({ client: f.client, cwd: "/work", wait: async () => {} });
    const [first, stale] = await Promise.all([f.lifecycle.start(f.request), second.start(f.request)]);
    expect(first.status).toBe("success");
    expect(stale.status).toBe("blocked");
    expect(f.events.filter(e => e === "create")).toHaveLength(1);
  });
  for (const failure of ["readFail", "startFail"] as const) test(`${failure} preserves old current without kickoff`, async () => {
    const f = fixture({ [failure]: true });
    expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
    expect(f.lifecycle.current?.paneId).toBe("old");
    expect(f.rows().map(a => a.pane_id)).toEqual(["old"]);
    expect(f.events).not.toContain("close:old");
    expect(f.events.some(e => e.includes(":kickoff"))).toBe(false);
    if (failure === "readFail") expect(f.events).not.toContain("create");
  });
  for (const provider of ["claude", "codex", "agy"] as const) {
    test(`${provider} reads before creation, compacts, acknowledges then retires and kicks off`, async () => {
      const f = fixture({ provider });
      expect((await f.lifecycle.start(f.request)).status).toBe("success");
      expect(f.events.indexOf("read:old")).toBeLessThan(f.events.indexOf("create"));
      expect(f.events.indexOf("read:new-1")).toBeLessThan(f.events.indexOf("close:old"));
      expect(f.events.indexOf("close:old")).toBeLessThan(f.events.indexOf("prompt:new-1:kickoff"));
      expect(f.prompts[0]).toContain("ONLY for importing and compacting historical context");
      expect(f.prompts[0]).not.toContain("must not launch");
      expect(f.lifecycle.current?.paneId).toBe("new-1");
    });
    for (const ack of ["missing", "empty", "prompt"] as const) test(`${provider} ${ack} acknowledgement cannot retire source`, async () => {
      const f = fixture({ provider, ack });
      expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
      expect(f.lifecycle.current?.paneId).toBe("old");
      expect(f.events).not.toContain("close:old");
      expect(f.events).toContain("close:new-1");
      expect(f.events.some(e => e.includes(":kickoff"))).toBe(false);
    });
  }
  test("chunks require distinct acknowledgements in the same exact pane", async () => {
    const f = fixture({ large: true });
    expect((await f.lifecycle.start(f.request)).status).toBe("success");
    const imports = f.prompts.filter(p => p.includes("ONLY for importing"));
    expect(imports).toHaveLength(3);
    expect(new Set(imports.map(p => p.match(/DROVR_HANDOFF_READY_[a-f0-9-]+/)![0])).size).toBe(3);
    expect(f.events.filter(e => e.startsWith("start:"))).toEqual(["start:new-1"]);
  });
  test("overlap keeps old identity and serializes prompt, stale switch and stop", async () => {
    const f = fixture();
    let release!: () => void;
    f.gate(new Promise(resolve => { release = resolve; }));
    const start = f.lifecycle.start(f.request);
    while (!f.events.includes("start:new-1")) await Promise.resolve();
    expect(f.lifecycle.current?.paneId).toBe("old");
    expect((await f.lifecycle.resolveCurrent())?.pane_id).toBe("old");
    const prompt = f.lifecycle.prompt("followup");
    const repeated = f.lifecycle.start(f.request);
    const stop = f.lifecycle.stop();
    expect(f.events.some(e => e.startsWith("prompt:"))).toBe(false);
    release();
    await start;
    await prompt;
    expect((await repeated).status).toBe("blocked");
    await stop;
    expect(f.events).toContain("prompt:new-1:other");
    expect(f.events.at(-1)).toBe("close:new-1");
  });
  test("changed native source or working source cannot commit", async () => {
    for (const change of ["history", "status", "session"]) {
      const f = fixture();
      let release!: () => void;
      f.gate(new Promise(resolve => { release = resolve; }));
      const start = f.lifecycle.start(f.request);
      while (!f.events.includes("start:new-1")) await Promise.resolve();
      if (change === "history") f.histories.set("old", "new history");
      else if (change === "status") f.rows()[0]!.agent_status = "working";
      else f.rows()[0]!.agent_session.value = "other-session";
      release();
      expect((await start).status).toBe("blocked");
      expect(f.lifecycle.current?.paneId).toBe("old");
      expect(f.events).not.toContain("close:old");
    }
  });
  test("retirement and kickoff failures retain acknowledged current", async () => {
    for (const failure of ["closeFail", "kickoffFail"] as const) {
      const f = fixture({ [failure]: true });
      expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
      expect(f.lifecycle.current?.paneId).toBe("new-1");
      expect(f.events).not.toContain("close:new-1");
      if (failure === "closeFail") expect(f.events).not.toContain("prompt:new-1:kickoff");
    }
  });
  test("restart with duplicate cwd fails closed, missing pinned pane never routes to its neighbor", async () => {
    const f = fixture();
    f.rows().push({ ...f.rows()[0]!, pane_id: "other" });
    expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
    expect(f.events).not.toContain("create");
    f.rows().pop();
    await f.lifecycle.resolveCurrent();
    f.rows()[0]!.pane_id = "other";
    expect(await f.lifecycle.prompt("work")).toBeUndefined();
    expect(f.events.some(e => e.startsWith("prompt:"))).toBe(false);
  });
});
