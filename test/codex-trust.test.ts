import { describe, expect, test } from "bun:test";
import { HerdrError, isTimeout, type ResultOf } from "@brooswit/herdr-sdk";
import { DrovrClient } from "../src/index.js";
import { buildFakeHerdrClient } from "./support/fake-herdr-client.js";

// Visible pane captured from the dedicated Herdr 0.8.2 smoke session.
const dialog = `> You are in /tmp/drovr-codex-trust.WZXAC0

  Do you trust the contents of this directory? Working with untrusted contents comes with
  higher risk of prompt injection. Trusting the directory allows project-local config, hooks,
  and exec policies to load.

\u203a 1. Yes, continue
  2. No, quit

  Press enter to continue
`;
const agent: ResultOf<"agent.get">["agent"] = {
  agent: "codex", agent_status: "idle", interactive_ready: true,
  pane_id: "w3:p1", terminal_id: "t1", workspace_id: "w3", tab_id: "w3:t1",
  focused: false, revision: 2,
};
const read: ResultOf<"pane.read"> = {
  type: "pane_read", read: { pane_id: agent.pane_id, workspace_id: "w3", tab_id: "w3:t1",
    source: "visible", format: "text", revision: 0, truncated: false, text: dialog },
};

describe("default Codex trust correction", () => {
  for (const method of ["agent.list", "agent.get", "agent.start", "agent.prompt", "agent.wait"] as const) {
    for (const route of ["service", "call"] as const) {
      test(`${method} via ${route} corrects the reproduced idle report`, async () => {
        const result = method === "agent.list" ? { type: "agent_list", agents: [agent] } : {
          type: method === "agent.start" ? "agent_started" : method === "agent.prompt" ? "agent_prompted" : "agent_info",
          agent, ...(method === "agent.start" ? { argv: ["codex"] } : {}),
        };
        const { client, calls } = buildFakeHerdrClient({ resultFor: c => c.method === "pane.read" ? read : result });
        const d = new DrovrClient({ herdr: client });
        const service = () => {
          switch (method) {
            case "agent.list": return d.agent.list();
            case "agent.get": return d.agent.get(agent.pane_id);
            case "agent.start": return d.agent.start({ kind: "codex", name: "probe", pane_id: agent.pane_id });
            case "agent.prompt": return d.agent.prompt({ target: agent.pane_id, text: "hello" });
            case "agent.wait": return d.agent.wait({ target: agent.pane_id, until: ["idle"] });
          }
        };
        const corrected = await (route === "service" ? service() : d.call(method, { target: agent.pane_id } as never));
        expect(corrected as unknown).toEqual("agents" in result
          ? { ...result, agents: [{ ...agent, agent_status: "blocked", interactive_ready: false }] }
          : { ...result, agent: { ...agent, agent_status: "blocked", interactive_ready: false } });
        expect(agent.agent_status).toBe("idle");
        expect(calls.map(c => c.method)).toEqual([method, "pane.read"]);
        expect(calls[1]!.args).toEqual([{ pane_id: agent.pane_id, source: "visible", format: "text", strip_ansi: true }]);
        expect(await d.raw.call(method, {} as never)).toBe(result as never);
      });
    }
  }

  for (const [name, text] of Object.entries({
    idle: "OpenAI Codex\n\u203a Implement a feature\n? for shortcuts",
    quoted: dialog.split("\n").map(line => `> ${line}`).join("\n"),
    fenced: "```text\n" + dialog + "```",
    stale: dialog + "\nOpenAI Codex\n\u203a Implement a feature",
    narrated: "Earlier the agent showed:\n" + dialog,
    noSelection: dialog.replace("\u203a 1.", "  1."),
    incomplete: "Do you trust the contents of this directory?",
  })) {
    test(`${name} preserves result identity`, async () => {
      const result = { type: "agent_info", agent };
      const { client } = buildFakeHerdrClient({ resultFor: c => c.method === "pane.read" ? { ...read, read: { ...read.read, text } } : result });
      expect(await new DrovrClient({ herdr: client }).agent.get(agent.pane_id)).toBe(result as never);
    });
  }

  test("wrapped dialog with No selected is still blocked", async () => {
    const { client } = buildFakeHerdrClient({ resultFor: c => c.method === "pane.read"
      ? { ...read, read: { ...read.read, text: dialog.replace("\u203a 1.", "1.").replace("  2.", "\u203a 2.") } }
      : { type: "agent_info", agent } });
    expect((await new DrovrClient({ herdr: client }).agent.get(agent.pane_id)).agent.agent_status).toBe("blocked");
  });

  for (const other of [{ ...agent, agent: "claude" }, { ...agent, agent: null },
    ...(["working", "unknown", "blocked"] as const).map(agent_status => ({ ...agent, agent_status }))]) {
    test(`does not probe ${other.agent}/${other.agent_status}`, async () => {
      const result = { type: "agent_info", agent: other };
      const { client, calls } = buildFakeHerdrClient({ resultFor: () => result });
      expect(await new DrovrClient({ herdr: client }).agent.get(agent.pane_id)).toBe(result as never);
      expect(calls).toHaveLength(1);
    });
  }

  test("background done trust dialog is blocked while normal done retains identity", async () => {
    const result = { type: "agent_info", agent: { ...agent, agent_status: "done", focused: false } };
    let screen = dialog;
    const { client } = buildFakeHerdrClient({ resultFor: c => c.method === "pane.read"
      ? { ...read, read: { ...read.read, text: screen } } : result });
    const d = new DrovrClient({ herdr: client });
    expect((await d.agent.get(agent.pane_id)).agent.agent_status).toBe("blocked");
    screen = "Task complete.\n\u203a Implement a feature";
    expect(await d.agent.get(agent.pane_id)).toBe(result as never);
  });

  for (const patch of [{ truncated: true }, { source: "recent" }, { pane_id: "w9:p9" }, { text: undefined }]) {
    test(`unusable raw read ${JSON.stringify(patch)} stays unknown`, async () => {
      const result = { type: "agent_info", agent };
      const { client } = buildFakeHerdrClient({ resultFor: c => c.method === "pane.read" ? { ...read, read: { ...read.read, ...patch } } : result });
      expect(await new DrovrClient({ herdr: client }).agent.get(agent.pane_id)).toBe(result as never);
    });
  }

  test("raw read failure preserves identity; original RPC timeout preserves error", async () => {
    const result = { type: "agent_info", agent };
    const error = HerdrError.from("agent.wait", { code: "timeout", message: "timeout" });
    const { client } = buildFakeHerdrClient({ resultFor: () => result, errorFor: c => c.method === "pane.read" || c.method === "agent.wait" ? error : undefined });
    const d = new DrovrClient({ herdr: client });
    expect(await d.agent.get(agent.pane_id)).toBe(result as never);
    try {
      await d.agent.wait({ target: agent.pane_id });
      throw new Error("expected timeout");
    } catch (caught) {
      expect(caught).toBe(error);
      expect(isTimeout(caught)).toBe(true);
    }
  });

  test("mixed list preserves unaffected agents and custom empty registry opts out", async () => {
    const control = { ...agent, pane_id: "w1:p1", agent: "claude" };
    const result = { type: "agent_list", agents: [agent, control] };
    const { client } = buildFakeHerdrClient({ resultFor: c => c.method === "pane.read" ? read : result });
    expect((await new DrovrClient({ herdr: client }).agent.list()).agents[1]).toBe(control);
    expect(await new DrovrClient({ herdr: client, corrections: {} }).agent.list()).toBe(result as never);
  });
});
