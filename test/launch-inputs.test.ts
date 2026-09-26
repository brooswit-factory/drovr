import { describe, expect, test } from "bun:test";
import { buildAgentStartParams, buildProviderLaunchArgs, checkManagedAgentArgv, mergeDevelopmentChannels, type ManagedAgentLaunch, type ManagedAgentProvider } from "../src/index.js";
import type { DrovrClient } from "../src/drovr-client.js";
import { ManagedHerdrLifecycle, type ManagedHerdrStartRequest } from "../src/managed-herdr-lifecycle.js";
import { ProviderAvailabilityRegistry } from "../src/provider-fallback.js";

/** A fresh workspace: no worker exists, so start launches once and kicks off. */
function fixture(provider: ManagedAgentProvider, prepared: Record<string, unknown> = {}) {
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
    ? { ...base, provider, effort: "high", mcpConfigPath: "/prepared/mcp.json", ...prepared }
    : provider === "codex"
      ? { ...base, provider, mcpServers: [], ...prepared }
      : { ...base, provider, ...prepared }) as ManagedAgentLaunch;
  const request = (overrides: Partial<ManagedHerdrStartRequest>): ManagedHerdrStartRequest => ({
    priority: [{ provider, accountId: "default" }],
    label: "role",
    kickoff: () => "kickoff",
    prepare: async () => ({ launch }),
    ...overrides,
  });
  return { lifecycle, request, started };
}

const CHANNELS = "--dangerously-load-development-channels";
/** Whether any argv entry is the channel flag, in either spelling. */
const hasChannelFlag = (args: readonly string[]): boolean => args.some(value => value === CHANNELS || value.startsWith(`${CHANNELS}=`));
const flagValues = (args: readonly string[], flag: string): string[] => {
  if (flag === CHANNELS) {
    // Each channel must be joined to its flag: the bare variadic form lets
    // `claude --bg` take the value as the session's first prompt.
    expect(args).not.toContain(CHANNELS);
    return args.flatMap(value => value.startsWith(`${CHANNELS}=`) ? [value.slice(CHANNELS.length + 1)] : []);
  }
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
    expect(hasChannelFlag(f.started[0]!.args)).toBe(false);
  });

  test("an empty channel list loads no development channels", async () => {
    const f = fixture("claude");
    expect((await f.lifecycle.start(f.request({ developmentChannels: [] }))).status).toBe("success");
    expect(hasChannelFlag(f.started[0]!.args)).toBe(false);
    expect(flagValues(f.started[0]!.args, "--mcp-config")).toEqual(["/prepared/mcp.json"]);
  });

  test.each(["codex", "agy"] as const)("%s accepts the same neutral inputs without Claude flags", async (provider) => {
    const f = fixture(provider);
    expect((await f.lifecycle.start(f.request({
      mcpConfigPath: "/requested/mcp.json",
      developmentChannels: ["server:butchr"],
    }))).status).toBe("success");
    expect(f.started[0]!.kind).toBe(provider);
    for (const flag of ["--mcp-config", "--permission-mode", "--effort"]) {
      expect(f.started[0]!.args).not.toContain(flag);
    }
    expect(hasChannelFlag(f.started[0]!.args)).toBe(false);
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
      "--dangerously-load-development-channels=server:butchr",
    ]);
    expect(buildAgentStartParams({ ...base, ...neutral, provider: "agy" }).args).toEqual([
      "--prompt-interactive", "go",
    ]);
    const codex = buildAgentStartParams({ ...base, ...neutral, provider: "codex", mcpServers: [] }).args ?? [];
    expect(codex.join(" ")).not.toContain("/work/mcp.json");
    expect(codex.join(" ")).not.toContain("server:butchr");
  });
});

describe("configured channels reach provider startup", () => {
  test("a Minecraft Claude session configured with YAPPR launches with its config and channel", async () => {
    const f = fixture("claude", { mcpConfigPath: "/sessions/minecraft/mcp.json" });
    expect((await f.lifecycle.start(f.request({ developmentChannels: ["server:yappr"] }))).status).toBe("success");
    const args = f.started[0]!.args;
    expect(flagValues(args, "--mcp-config")).toEqual(["/sessions/minecraft/mcp.json"]);
    expect(flagValues(args, "--dangerously-load-development-channels")).toEqual(["server:yappr"]);
  });

  test("a requested channel joins the launch's existing channels instead of replacing them", async () => {
    const f = fixture("claude", { developmentChannels: ["server:butchr", "server:baker"] });
    expect((await f.lifecycle.start(f.request({ developmentChannels: ["server:yappr"] }))).status).toBe("success");
    expect(flagValues(f.started[0]!.args, "--dangerously-load-development-channels"))
      .toEqual(["server:butchr", "server:baker", "server:yappr"]);
  });

  test("a channel configured on both sides is passed to the provider once", async () => {
    const f = fixture("claude", { developmentChannels: ["server:yappr"] });
    expect((await f.lifecycle.start(f.request({ developmentChannels: ["server:yappr", "server:butchr"] }))).status).toBe("success");
    expect(flagValues(f.started[0]!.args, "--dangerously-load-development-channels"))
      .toEqual(["server:yappr", "server:butchr"]);
  });

  test("an empty request list preserves the channels the launch already configures", async () => {
    const f = fixture("claude", { developmentChannels: ["server:yappr"] });
    expect((await f.lifecycle.start(f.request({ developmentChannels: [] }))).status).toBe("success");
    expect(flagValues(f.started[0]!.args, "--dangerously-load-development-channels")).toEqual(["server:yappr"]);
  });

  test.each(["codex", "agy"] as const)("%s keeps its existing channels neutral and unspelled", async (provider) => {
    const f = fixture(provider, { developmentChannels: ["server:butchr"] });
    expect((await f.lifecycle.start(f.request({ developmentChannels: ["server:yappr"] }))).status).toBe("success");
    expect(f.started[0]!.args.join(" ")).not.toContain("server:yappr");
    expect(hasChannelFlag(f.started[0]!.args)).toBe(false);
  });

  test("merging channels keeps first-mention order and drops duplicates", () => {
    expect(mergeDevelopmentChannels(["server:butchr"], undefined, ["server:yappr", "server:butchr"]))
      .toEqual(["server:butchr", "server:yappr"]);
    expect(mergeDevelopmentChannels(undefined, [])).toEqual([]);
  });

  test("a live Claude process missing one configured channel has drifted", () => {
    const expected = buildAgentStartParams({
      provider: "claude", name: "minecraft", paneId: "w1:p1", cwd: "/sessions/minecraft",
      prompt: "play", effort: "high", mcpConfigPath: "/sessions/minecraft/mcp.json",
      developmentChannels: ["server:butchr", "server:yappr"],
    }).args!;
    expect(checkManagedAgentArgv(expected, expected)).toEqual({ ok: true });
    const drifted = expected.filter(value => value !== `${CHANNELS}=server:yappr`);
    expect(checkManagedAgentArgv(expected, drifted)).toEqual({
      ok: false,
      reason: "argv lacks --dangerously-load-development-channels server:yappr",
    });
  });

  test("a live process launched with the older spaced form still reads as carrying its channels", () => {
    const expected = buildProviderLaunchArgs("claude", { mcpConfigPath: "/w/mcp.json", mcpNotificationServers: ["butchr", "yappr"] });
    const olderLaunch = ["--mcp-config", "/w/mcp.json", CHANNELS, "server:butchr", "server:yappr"];
    expect(checkManagedAgentArgv(expected, olderLaunch)).toEqual({ ok: true });
    expect(checkManagedAgentArgv(expected, ["--mcp-config", "/w/mcp.json", CHANNELS, "server:butchr"])).toEqual({
      ok: false,
      reason: "argv lacks --dangerously-load-development-channels server:yappr",
    });
  });

  test("no channel value stands alone in argv, where `claude --bg` would take it as the prompt", () => {
    const args = buildProviderLaunchArgs("claude", { mcpConfigPath: "/w/mcp.json", mcpNotificationServers: ["yappr", "rocketr"] });
    expect(args).toEqual([
      "--mcp-config", "/w/mcp.json",
      `${CHANNELS}=server:yappr`, `${CHANNELS}=server:rocketr`,
    ]);
    expect(args.filter(value => value.startsWith("server:"))).toEqual([]);
  });
});

describe("a direct CLI launch outside Herdr", () => {
  test("Claude gets the session config and one channel per notifying MCP server", () => {
    expect(buildProviderLaunchArgs("claude", {
      mcpConfigPath: "/home/brooswit/code/brooswit/.mcp.json",
      mcpNotificationServers: ["yappr"],
    })).toEqual([
      "--mcp-config", "/home/brooswit/code/brooswit/.mcp.json",
      "--dangerously-load-development-channels=server:yappr",
    ]);
  });

  test("named channels and notifying servers combine without repeating one", () => {
    expect(buildProviderLaunchArgs("claude", {
      developmentChannels: ["server:yappr", "server:butchr"],
      mcpNotificationServers: ["yappr", "atlassian"],
    })).toEqual([
      "--dangerously-load-development-channels=server:yappr", "--dangerously-load-development-channels=server:butchr", "--dangerously-load-development-channels=server:atlassian",
    ]);
  });

  test("a caller that configures nothing gets no flags at all", () => {
    expect(buildProviderLaunchArgs("claude", {})).toEqual([]);
    expect(buildProviderLaunchArgs("claude", { mcpNotificationServers: [] })).toEqual([]);
  });

  test("BUTCHR-453: strictMcpConfig emits --strict-mcp-config alongside --mcp-config for Claude", () => {
    expect(buildProviderLaunchArgs("claude", {
      mcpConfigPath: "/w/mcp.json",
      strictMcpConfig: true,
    })).toEqual(["--mcp-config", "/w/mcp.json", "--strict-mcp-config"]);
  });

  test("BUTCHR-453: absent/false strictMcpConfig emits no flag — today's behaviour exactly", () => {
    expect(buildProviderLaunchArgs("claude", { mcpConfigPath: "/w/mcp.json" }))
      .toEqual(["--mcp-config", "/w/mcp.json"]);
    expect(buildProviderLaunchArgs("claude", { mcpConfigPath: "/w/mcp.json", strictMcpConfig: false }))
      .toEqual(["--mcp-config", "/w/mcp.json"]);
  });

  test.each(["codex", "agy"] as const)("BUTCHR-453: %s takes strictMcpConfig without spelling a flag", (provider) => {
    expect(buildProviderLaunchArgs(provider, { mcpConfigPath: "/w/mcp.json", strictMcpConfig: true })).toEqual([]);
  });

  test.each(["codex", "agy"] as const)("%s takes the same inputs and spells no Claude flag", (provider) => {
    expect(buildProviderLaunchArgs(provider, {
      mcpConfigPath: "/home/brooswit/code/brooswit/.mcp.json",
      mcpNotificationServers: ["yappr"],
    })).toEqual([]);
  });

  test("a malformed MCP server name is refused rather than passed on", () => {
    for (const name of ["yappr extra", "yappr.dev", "", "yappr;rm"]) {
      expect(() => buildProviderLaunchArgs("claude", { mcpNotificationServers: [name] }))
        .toThrow("Unsupported MCP server name");
    }
  });

  test("a dash-led server name reaches argv as a channel, never as a flag of its own", () => {
    // The name passes the identifier check (letters and dashes); what keeps it
    // out of flag position is the channel prefix, so pin that rather than a throw.
    expect(buildProviderLaunchArgs("claude", { mcpNotificationServers: ["--dangerously-skip-permissions"] }))
      .toEqual(["--dangerously-load-development-channels=server:--dangerously-skip-permissions"]);
  });

  test("a managed Herdr launch spells its channels the same way", () => {
    const args = buildAgentStartParams({
      provider: "claude", name: "coordinator", paneId: "w1:p1", cwd: "/home/brooswit/code/brooswit",
      prompt: "coordinate", effort: "high", mcpConfigPath: "/home/brooswit/code/brooswit/.mcp.json",
      mcpNotificationServers: ["yappr"],
    }).args!;
    expect(args.slice(args.indexOf("--mcp-config"))).toEqual([
      "--mcp-config", "/home/brooswit/code/brooswit/.mcp.json",
      "--dangerously-load-development-channels=server:yappr",
    ]);
  });

  test("a request naming a notifying server reaches startup through the lifecycle", async () => {
    const f = fixture("claude", { mcpConfigPath: "/home/brooswit/code/brooswit/.mcp.json" });
    expect((await f.lifecycle.start(f.request({ mcpNotificationServers: ["yappr"] }))).status).toBe("success");
    expect(flagValues(f.started[0]!.args, "--dangerously-load-development-channels")).toEqual(["server:yappr"]);
  });
});
