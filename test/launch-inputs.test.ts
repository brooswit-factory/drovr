import { describe, expect, test } from "bun:test";
import { buildAgentStartParams, type ManagedAgentLaunch, type ManagedAgentProvider } from "../src/index.js";
import type { DrovrClient } from "../src/drovr-client.js";
import { ManagedHerdrLifecycle, type ManagedHerdrStartRequest } from "../src/managed-herdr-lifecycle.js";
import { ProviderAvailabilityRegistry } from "../src/provider-fallback.js";

/** A fresh workspace: no worker exists, so start launches once and kicks off. */
function fixture(provider: ManagedAgentProvider) {
  const started: { kind: string; args: string[] }[] = [];
  const rows: { pane_id: string; cwd: string; agent: string; agent_status: string }[] = [];
  const client = {
    agent: {
      list: async () => ({ agents: rows }),
      start: async (params: any) => {
        started.push({ kind: params.kind, args: [...params.args] });
        rows.push({ pane_id: params.pane_id, cwd: "/work", agent: params.kind, agent_status: "working" });
      },
      prompt: async ({ target }: any) => ({ agent: rows.find(row => row.pane_id === target)! }),
    },
    workspace: { create: async () => ({ root_pane: "new-1" }) },
    pane: {
      close: async () => {},
      read: async () => { throw new Error("Screen must never be read during launch"); },
    },
  };
  const lifecycle = new ManagedHerdrLifecycle({
    client: client as unknown as DrovrClient,
    cwd: "/work",
    availability: new ProviderAvailabilityRegistry(),
    wait: async () => {},
  });
  const base = { cwd: "/work", name: "role", paneId: "ignored", prompt: "must not launch" };
  const launch = (provider === "claude"
    ? { ...base, provider, effort: "high", mcpConfigPath: "/prepared/mcp.json" }
    : provider === "codex"
      ? { ...base, provider, mcpServers: [] }
      : { ...base, provider }) as ManagedAgentLaunch;
  const request = (overrides: Partial<ManagedHerdrStartRequest>): ManagedHerdrStartRequest => ({
    priority: [{ provider, accountId: "default" }],
    label: "role",
    kickoff: () => "kickoff",
    prepare: async () => ({ launch }),
    ...overrides,
  });
  return { lifecycle, request, started };
}

const flagValues = (args: readonly string[], flag: string): string[] => {
  const index = args.indexOf(flag);
  if (index < 0) return [];
  const rest = args.slice(index + 1);
  const next = rest.findIndex(value => value.startsWith("--"));
  return next < 0 ? [...rest] : rest.slice(0, next);
};

describe("provider-neutral MCP configuration and development channels", () => {
  test("a Claude request's channel names reach the launch as Claude's flag", async () => {
    const f = fixture("claude");
    expect((await f.lifecycle.start(f.request({ developmentChannels: ["server:butchr", "server:baker"] }))).status).toBe("success");
    expect(f.started).toHaveLength(1);
    expect(flagValues(f.started[0]!.args, "--dangerously-load-development-channels")).toEqual(["server:butchr", "server:baker"]);
  });

  test("a request's MCP configuration overrides the prepared launch for Claude", async () => {
    const f = fixture("claude");
    expect((await f.lifecycle.start(f.request({ mcpConfigPath: "/requested/mcp.json" }))).status).toBe("success");
    expect(flagValues(f.started[0]!.args, "--mcp-config")).toEqual(["/requested/mcp.json"]);
  });

  test("a prepared MCP configuration survives a request that names none", async () => {
    const f = fixture("claude");
    expect((await f.lifecycle.start(f.request({}))).status).toBe("success");
    expect(flagValues(f.started[0]!.args, "--mcp-config")).toEqual(["/prepared/mcp.json"]);
    expect(f.started[0]!.args).not.toContain("--dangerously-load-development-channels");
  });

  test("an empty channel list loads no development channels", async () => {
    const f = fixture("claude");
    expect((await f.lifecycle.start(f.request({ developmentChannels: [] }))).status).toBe("success");
    expect(f.started[0]!.args).not.toContain("--dangerously-load-development-channels");
    expect(flagValues(f.started[0]!.args, "--mcp-config")).toEqual(["/prepared/mcp.json"]);
  });

  test.each(["codex", "agy"] as const)("%s accepts the same neutral inputs without Claude flags", async (provider) => {
    const f = fixture(provider);
    expect((await f.lifecycle.start(f.request({
      mcpConfigPath: "/requested/mcp.json",
      developmentChannels: ["server:butchr"],
    }))).status).toBe("success");
    expect(f.started[0]!.kind).toBe(provider);
    for (const flag of ["--mcp-config", "--dangerously-load-development-channels", "--permission-mode", "--effort"]) {
      expect(f.started[0]!.args).not.toContain(flag);
    }
    expect(f.started[0]!.args.join(" ")).not.toContain("/requested/mcp.json");
    expect(f.started[0]!.args.join(" ")).not.toContain("server:butchr");
  });

  test("the launch API alone translates neutral inputs per provider", () => {
    const base = { name: "role", paneId: "w1:p1", cwd: "/work", prompt: "go" } as const;
    const neutral = { mcpConfigPath: "/work/mcp.json", developmentChannels: ["server:butchr"] } as const;
    expect(buildAgentStartParams({ ...base, ...neutral, provider: "claude", effort: "high" }).args).toEqual([
      "go",
      "--effort", "high",
      "--permission-mode", "bypassPermissions",
      "--mcp-config", "/work/mcp.json",
      "--dangerously-load-development-channels", "server:butchr",
    ]);
    expect(buildAgentStartParams({ ...base, ...neutral, provider: "agy" }).args).toEqual([
      "--prompt-interactive", "go",
    ]);
    const codex = buildAgentStartParams({ ...base, ...neutral, provider: "codex", mcpServers: [] }).args ?? [];
    expect(codex.join(" ")).not.toContain("/work/mcp.json");
    expect(codex.join(" ")).not.toContain("server:butchr");
  });
});
