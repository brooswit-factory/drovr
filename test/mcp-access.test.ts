import { describe, expect, test } from "bun:test";
import {
  AgyDeniedActionsError,
  IdentityStillHeldError,
  ManagedConversationRunner,
  applyMcpAccess,
  awaitIdentityRelease,
  mcpAccessProvisioning,
  mcpServersFromMcpJson,
  notificationSupport,
  setMcpAccess,
  switchProviderMcpAccess,
  type McpAccessDeclaration,
  type McpSettingsIo,
} from "../src/index.js";

const YAPPR: McpAccessDeclaration = {
  cwd: "/home/brooswit/code/brooswit-factory/yappr",
  home: "/home/brooswit",
  servers: [{ name: "yappr", notifications: true }],
};

function files(initial: Record<string, string> = {}) {
  const written: { path: string; contents: string }[] = [];
  const store = { ...initial };
  const io: McpSettingsIo = {
    readSettings: async (path) => store[path],
    writeSettings: async (path, contents) => { store[path] = contents; written.push({ path, contents }); },
  };
  return { io, written, store, json: (path: string) => JSON.parse(store[path]!) };
}

describe("one declaration, each vendor's own dialect", () => {
  test("claude is granted the workspace's .mcp.json servers where it actually reads them", async () => {
    const f = files();
    const applied = await applyMcpAccess("claude", YAPPR, f.io);

    const path = `${YAPPR.cwd}/.claude/settings.local.json`;
    expect(applied.written).toEqual([path]);
    // FALSIFIER: without this the session sits blocked on an approval prompt
    // it cannot be answered out of, and never registers its identity at all.
    expect(f.json(path)).toEqual({ enabledMcpjsonServers: ["yappr"] });
    expect(applied.restartRequired).toBe(true);
  });

  test("agy is granted the same intent as a home-level permission", async () => {
    const f = files();
    await applyMcpAccess("agy", YAPPR, f.io);
    expect(f.json("/home/brooswit/.gemini/antigravity-cli/settings.json"))
      .toEqual({ permissions: { allow: ["mcp(yappr/*)"] } });
  });

  test("agy gets the servers themselves too, in the format agy 1.2.6 writes, keeping the servers it already has", async () => {
    // usrr's own .mcp.json shape: rocketr over http with account headers, yappr over stdio with env.
    const definitions = mcpServersFromMcpJson({ mcpServers: {
      rocketr: { type: "http", url: "http://127.0.0.1:8790/mcp", headers: { "x-rocketr-account": "usrr-kchb-thinkpad", "x-rocketr-channel": "on" } },
      yappr: { type: "stdio", command: "/home/brooswit/.bun/bin/bun", args: ["run", "/x/yappr.ts"], env: { YAPPR_AGENT: "usrr-kchb-thinkpad" } },
    } });
    const config = "/home/brooswit/.gemini/config/mcp_config.json";
    const f = files({ [config]: JSON.stringify({ mcpServers: { other: { command: "keep-me" } }, extra: 1 }) });
    const applied = await applyMcpAccess("agy", {
      cwd: "/home/brooswit/code/brooswit-factory/usrr",
      home: "/home/brooswit",
      servers: [{ name: "rocketr", definition: definitions.rocketr! }, { name: "yappr", definition: definitions.yappr! }],
    }, f.io);
    expect(applied.written).toEqual([config, "/home/brooswit/.gemini/antigravity-cli/settings.json"]);
    // Exactly what `agy mcp add` wrote for the same two servers (measured 2026-09-18).
    expect(f.json(config)).toEqual({
      extra: 1,
      mcpServers: {
        other: { command: "keep-me" },
        rocketr: { disabled: false, headers: { "x-rocketr-account": "usrr-kchb-thinkpad", "x-rocketr-channel": "on" }, serverUrl: "http://127.0.0.1:8790/mcp" },
        yappr: { args: ["run", "/x/yappr.ts"], command: "/home/brooswit/.bun/bin/bun", disabled: false, env: { YAPPR_AGENT: "usrr-kchb-thinkpad" } },
      },
    });
    expect(f.json("/home/brooswit/.gemini/antigravity-cli/settings.json")).toEqual({ permissions: { allow: ["mcp(rocketr/*)", "mcp(yappr/*)"] } });
  });

  test("a .mcp.json entry with neither a url nor a command is refused, not guessed at", () => {
    expect(() => mcpServersFromMcpJson({ mcpServers: { odd: { command: "x", url: undefined } as never, none: {} } })).toThrow("neither a url nor a command");
    // agy offers only stdio and http, so an SSE server is refused here, not at connect time.
    expect(() => mcpServersFromMcpJson({ mcpServers: { old: { type: "sse", url: "http://h/sse" } } })).toThrow('type "sse"');
    expect(() => mcpServersFromMcpJson({})).toThrow("no mcpServers");
    expect(() => mcpServersFromMcpJson({ mcpServers: { x: { url: "http://h", headers: { a: 1 } } } })).toThrow("x.headers");
  });

  test("a declared server replaces its whole entry: the declaration is authoritative for it", async () => {
    const config = "/home/brooswit/.gemini/config/mcp_config.json";
    const f = files({ [config]: JSON.stringify({ mcpServers: { rocketr: { serverUrl: "http://old", disabled: true, note: "x" } } }) });
    await applyMcpAccess("agy", {
      cwd: "/home/brooswit/code/brooswit-factory/usrr", home: "/home/brooswit",
      servers: [{ name: "rocketr", definition: { type: "http", url: "http://127.0.0.1:8790/mcp" } }],
    }, f.io);
    expect(f.json(config).mcpServers.rocketr).toEqual({ disabled: false, serverUrl: "http://127.0.0.1:8790/mcp" });
  });

  test("a declaration without definitions leaves agy's server file alone", async () => {
    const f = files();
    const applied = await applyMcpAccess("agy", YAPPR, f.io);
    expect(applied.written).toEqual(["/home/brooswit/.gemini/antigravity-cli/settings.json"]);
  });

  test("naming tools narrows agy's permission to exactly those tools", async () => {
    const f = files();
    await applyMcpAccess("agy", { ...YAPPR, servers: [{ name: "yappr", tools: ["yappr_send", "yappr_receive"] }] }, f.io);
    expect(f.json("/home/brooswit/.gemini/antigravity-cli/settings.json").permissions.allow)
      .toEqual(["mcp(yappr/yappr_send)", "mcp(yappr/yappr_receive)"]);
  });

  test("codex needs no settings file: its servers travel as start arguments", () => {
    expect(mcpAccessProvisioning("codex", YAPPR).edits).toEqual([]);
    expect(mcpAccessProvisioning("codex", YAPPR).notificationServers).toEqual(["yappr"]);
  });

  test("settings this declaration does not govern are preserved, not replaced", async () => {
    const f = files({
      [`${YAPPR.cwd}/.claude/settings.local.json`]: JSON.stringify({
        enabledMcpjsonServers: ["butchr"],
        permissions: { allow: ["Bash(git status)"] },
      }),
    });
    await applyMcpAccess("claude", YAPPR, f.io);
    expect(f.json(`${YAPPR.cwd}/.claude/settings.local.json`)).toEqual({
      enabledMcpjsonServers: ["butchr", "yappr"],
      permissions: { allow: ["Bash(git status)"] },
    });
  });

  test("access that is already granted, to a process already subscribed, does nothing", async () => {
    const f = files({
      [`${YAPPR.cwd}/.claude/settings.local.json`]: JSON.stringify({ enabledMcpjsonServers: ["yappr"] }),
    });
    const applied = await applyMcpAccess("claude", YAPPR, f.io, { notificationServers: ["yappr"] });
    expect(applied).toMatchObject({ changed: false, restartRequired: false, written: [] });
    expect(f.written).toEqual([]);
  });

  test("settings that cannot be parsed are refused, never overwritten", async () => {
    const f = files({ [`${YAPPR.cwd}/.claude/settings.local.json`]: "{ not json" });
    await expect(applyMcpAccess("claude", YAPPR, f.io)).rejects.toThrow("refusing to overwrite");
    expect(f.written).toEqual([]);
  });

  test("a server name that is not a plain identifier is refused", () => {
    expect(() => mcpAccessProvisioning("agy", { ...YAPPR, servers: [{ name: "yappr/*" }] }))
      .toThrow("Unsupported MCP server name");
  });
});

describe("a write alone never reaches a running agent", () => {
  test("changing access provisions first, then stops, then starts", async () => {
    const order: string[] = [];
    const f = files();
    const change = await setMcpAccess("claude", YAPPR, {
      io: { readSettings: f.io.readSettings, writeSettings: async (p, c) => { order.push("provision"); await f.io.writeSettings(p, c); } },
      stop: async () => { order.push("stop"); },
      released: async () => { order.push("check-released"); return true; },
      start: async () => { order.push("start"); return "session-2"; },
    });

    // FALSIFIER: any order but this one leaves the new process reading settings
    // that were not yet written, or declares readiness while the old one holds on.
    expect(order).toEqual(["provision", "stop", "check-released", "start"]);
    expect(change.restarted).toBe("session-2");
  });

  test("an agent already holding the access is left running", async () => {
    const f = files({ [`${YAPPR.cwd}/.claude/settings.local.json`]: JSON.stringify({ enabledMcpjsonServers: ["yappr"] }) });
    let stopped = false;
    const change = await setMcpAccess("claude", YAPPR, {
      io: f.io,
      stop: async () => { stopped = true; },
      released: async () => true,
      start: async () => "session-2",
    }, { notificationServers: ["yappr"] });
    expect(stopped).toBe(false);
    expect(change.restarted).toBeUndefined();
  });

  test("switching provider provisions the TARGET vendor before its first process starts", async () => {
    const order: string[] = [];
    const f = files();
    await switchProviderMcpAccess("agy", YAPPR, {
      io: { readSettings: f.io.readSettings, writeSettings: async (p, c) => { order.push("provision-agy"); await f.io.writeSettings(p, c); } },
      start: async () => { order.push("start-agy"); return "conversation-1"; },
    });
    // FALSIFIER: reversed, the first turn on the new provider comes up toolless
    // and, on agy, silently succeeds with empty output.
    expect(order).toEqual(["provision-agy", "start-agy"]);
    expect(f.json("/home/brooswit/.gemini/antigravity-cli/settings.json").permissions.allow).toEqual(["mcp(yappr/*)"]);
  });
});

describe("a single-holder identity is released, not assumed released", () => {
  test("readiness waits for a real confirmation, not a duration", async () => {
    let clock = 0;
    const asked: number[] = [];
    let holder = true;
    await awaitIdentityRelease({
      released: async () => { asked.push(clock); if (clock >= 750) holder = false; return !holder; },
      now: () => clock, sleep: async (ms) => { clock += ms; }, pollMs: 250, timeoutMs: 5_000,
    });
    expect(asked).toEqual([0, 250, 500, 750]);
  });

  test("REGRESSION: a registration that is never reaped fails loudly instead of starting a toolless agent", async () => {
    let clock = 0;
    let started = false;
    const f = files();
    // The measured failure: the bridge child died, the registration stayed
    // connected:true forever, and every new bridge was refused.
    await expect(setMcpAccess("claude", YAPPR, {
      io: f.io,
      stop: async () => {},
      released: async () => false,
      start: async () => { started = true; return "session-2"; },
      now: () => clock, sleep: async (ms) => { clock += ms; }, pollMs: 100, timeoutMs: 1_000,
    })).rejects.toBeInstanceOf(IdentityStillHeldError);
    // FALSIFIER: starting here is exactly the state that looked like broken MCP
    // configuration and was only cleared by a service-wide restart.
    expect(started).toBe(false);
  });
});

describe("a denied AGY turn is a denial, not an empty answer", () => {
  const runner = (stdout: string) => new ManagedConversationRunner({
    provider: "agy", cwd: "/work", run: async () => ({ exitCode: 0, stdout, stderr: "" }),
  });

  test("REGRESSION: SUCCESS with an empty response and denied actions is refused", async () => {
    const stdout = JSON.stringify({
      status: "SUCCESS", conversation_id: "c1", response: "",
      denied_actions: [{ action: "mcp", display_name: "CallMcpTool" }],
    });
    // FALSIFIER: parsed as a result, a host persists this as a normal assistant
    // turn that said nothing, and the missing permission stays invisible.
    const error = await runner(stdout).message("hello").catch((e) => e);
    expect(error).toBeInstanceOf(AgyDeniedActionsError);
    expect(error.deniedActions).toEqual(["CallMcpTool"]);
    expect(error.message).toContain("CallMcpTool");
  });

  test("a denial alongside real output is still the model's answer", async () => {
    const stdout = JSON.stringify({
      status: "SUCCESS", conversation_id: "c1", response: "I could not call the tool, so here is what I know.",
      denied_actions: [{ action: "mcp", display_name: "CallMcpTool" }],
    });
    expect(await runner(stdout).message("hello")).toEqual({
      conversationId: "c1", response: "I could not call the tool, so here is what I know.",
    });
  });

  test("an ordinary empty answer with nothing denied is unchanged", async () => {
    const stdout = JSON.stringify({ status: "SUCCESS", conversation_id: "c1", response: "" });
    expect(await runner(stdout).message("hello")).toEqual({ conversationId: "c1", response: "" });
  });
});

describe("subscribing is a separate act from enabling, and a launch-time one", () => {
  test("REGRESSION: a subscription the running process lacks needs a FRESH launch, not a restart", async () => {
    const f = files({
      [`${YAPPR.cwd}/.claude/settings.local.json`]: JSON.stringify({ enabledMcpjsonServers: ["yappr"] }),
    });
    // Enablement is already on disk, so nothing is written — and yet the
    // running process still has no subscription, because that was a launch
    // argument it never received.
    const applied = await applyMcpAccess("claude", YAPPR, f.io, { notificationServers: [] });
    expect(applied.written).toEqual([]);
    // FALSIFIER: "restart" here is what a respawn satisfies, and a respawn
    // carries no flags ever — the session comes back still unsubscribed.
    expect(applied.restart).toBe("fresh-launch");
  });

  test("a process already launched with the channel needs nothing", async () => {
    const f = files({
      [`${YAPPR.cwd}/.claude/settings.local.json`]: JSON.stringify({ enabledMcpjsonServers: ["yappr"] }),
    });
    const applied = await applyMcpAccess("claude", YAPPR, f.io, { notificationServers: ["yappr"] });
    expect(applied.restart).toBe("none");
  });

  test("enablement alone is satisfied by an ordinary restart", async () => {
    const f = files();
    const applied = await applyMcpAccess("claude", { ...YAPPR, servers: [{ name: "yappr" }] }, f.io);
    expect(applied.changed).toBe(true);
    expect(applied.restart).toBe("restart");
  });

  test("an unknown subscription state is reported, never guessed either way", async () => {
    const f = files({ [`${YAPPR.cwd}/.claude/settings.local.json`]: JSON.stringify({ enabledMcpjsonServers: ["yappr"] }) });
    const applied = await applyMcpAccess("claude", YAPPR, f.io);
    // Guessing "unsubscribed" demands a fresh launch on every call and never
    // converges; guessing "subscribed" reproduces the bug. So: say so.
    expect(applied.restart).toBe("none");
    expect(applied.subscriptionUnverified).toBe(true);
  });

  test("the restart is told which kind it must be", async () => {
    const f = files({ [`${YAPPR.cwd}/.claude/settings.local.json`]: JSON.stringify({ enabledMcpjsonServers: ["yappr"] }) });
    const kinds: string[] = [];
    await setMcpAccess("claude", YAPPR, {
      io: f.io, stop: async () => {}, released: async () => true,
      start: async (kind) => { kinds.push(kind); return "session-2"; },
    }, { notificationServers: [] });
    expect(kinds).toEqual(["fresh-launch"]);
  });
});

describe("the ceiling on notifications is stated, not silently missed", () => {
  test.each(["agy", "codex"] as const)("%s can never be woken by a channel frame", (provider) => {
    const support = notificationSupport(provider);
    expect(support.supported).toBe(false);
    if (!support.supported) expect(support.reason).toContain("Claude Code");
  });

  test("headless Claude has no acceptor, so it is not supported either", () => {
    const support = notificationSupport("claude", "print");
    expect(support.supported).toBe(false);
    if (!support.supported) expect(support.reason).toContain("acceptor");
  });

  test("interactive Claude is supported, with its conditions and its caveat named", () => {
    const support = notificationSupport("claude", "interactive");
    expect(support.supported).toBe(true);
    if (support.supported) {
      expect(support.requires).toContain("a fresh launch or fork, never a respawn");
      // Honest about what is still not guaranteed once every condition holds.
      expect(support.caveat).toContain("accept");
    }
  });

  test("asking agy for notifications reports the refusal instead of dropping it", async () => {
    const f = files();
    const applied = await applyMcpAccess("agy", YAPPR, f.io);
    expect(applied.notificationServers).toEqual(["yappr"]);
    expect(applied.notifications.supported).toBe(false);
    // FALSIFIER: no fresh launch is demanded for a subscription that can never
    // arrive; promising one would be a restart loop that never converges.
    expect(applied.restart).toBe("restart");
  });
});
