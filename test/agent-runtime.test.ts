import { describe, expect, test } from "bun:test";
import { buildAgentStartParams, checkManagedAgentArgv, inventoryCodexMcpServers, managedAgentProviderOfProcess, parseCodexMcpInventory, type AgyAgentLaunch, type CodexAgentLaunch } from "../src/index.js";

describe("provider-owned agent launch plans", () => {
  test("recognizes managed providers from executable or process name", () => {
    expect(managedAgentProviderOfProcess({ argv: ["/usr/bin/claude"] })).toBe("claude");
    expect(managedAgentProviderOfProcess({ argv: ["node"], name: "codex" })).toBe("codex");
    expect(managedAgentProviderOfProcess({ argv: ["/home/worker/.local/bin/agy"] })).toBe("agy");
    expect(managedAgentProviderOfProcess({ name: "agy" })).toBe("agy");
    expect(managedAgentProviderOfProcess({ argv: ["fish"], name: "fish" })).toBeUndefined();
  });

  test("checks provider-owned persistent launch arguments", () => {
    const expected = ["--permission-mode", "bypassPermissions", "--mcp-config", "/w/mcp.json", "--dangerously-load-development-channels=server:butchr"];
    expect(checkManagedAgentArgv(expected, expected)).toEqual({ ok: true });
    expect(checkManagedAgentArgv(expected, ["--permission-mode", "bypassPermissions"])).toEqual({
      ok: false,
      reason: "argv lacks --mcp-config /w/mcp.json, --dangerously-load-development-channels server:butchr",
    });
  });

  test("BUTCHR-453: a live process missing --strict-mcp-config reads as drifted, same as any other required flag", () => {
    const expected = ["--permission-mode", "bypassPermissions", "--mcp-config", "/w/mcp.json", "--strict-mcp-config"];
    expect(checkManagedAgentArgv(expected, expected)).toEqual({ ok: true });
    expect(checkManagedAgentArgv(expected, ["--permission-mode", "bypassPermissions", "--mcp-config", "/w/mcp.json"])).toEqual({
      ok: false,
      reason: "argv lacks --strict-mcp-config",
    });
    // Not required when the expected launch never asked for it.
    const withoutStrict = ["--permission-mode", "bypassPermissions", "--mcp-config", "/w/mcp.json"];
    expect(checkManagedAgentArgv(withoutStrict, withoutStrict)).toEqual({ ok: true });
  });

  test("parses and filters Codex MCP inventory", () => {
    const output = JSON.stringify([
      { name: "butchr", transport: { type: "streamable_http" } },
      { name: "yappr", transport: { type: "stdio" } },
    ]);
    expect(parseCodexMcpInventory(output, ["butchr"])).toEqual([{ name: "yappr", transport: "stdio" }]);
    expect(() => parseCodexMcpInventory(JSON.stringify([{ name: "bad.name", transport: { type: "stdio" } }]))).toThrow("Unsupported Codex MCP server name");
  });

  test("bounds Codex MCP probing into an explicit result", () => {
    expect(inventoryCodexMcpServers(["butchr"], () => ({ exitCode: 0, stdout: "[]" }))).toEqual({ ok: true, servers: [] });
    const failed = inventoryCodexMcpServers([], () => { throw new Error("secret provider output"); });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).not.toContain("secret provider output");
  });
  test("builds the complete Claude launch for Herdr", () => {
    expect(buildAgentStartParams({
      provider: "claude",
      name: "butchr-test-1",
      paneId: "w1:p1",
      cwd: "/work/TEST-1",
      prompt: "follow your CLAUDE.md",
      model: "opus",
      effort: "high",
      mcpConfigPath: "/work/TEST-1/mcp.json",
      developmentChannels: ["server:butchr"],
      timeoutMs: 30_000,
    })).toEqual({
      kind: "claude",
      name: "butchr-test-1",
      pane_id: "w1:p1",
      timeout_ms: 30_000,
      args: [
        "follow your CLAUDE.md",
        "--model", "opus",
        "--effort", "high",
        "--permission-mode", "bypassPermissions",
        "--mcp-config", "/work/TEST-1/mcp.json",
        "--dangerously-load-development-channels=server:butchr",
      ],
    });
  });

  test("BUTCHR-453: strictMcpConfig: true produces --strict-mcp-config in a Claude launch's argv", () => {
    expect(buildAgentStartParams({
      provider: "claude",
      name: "butchr-test-1",
      paneId: "w1:p1",
      cwd: "/work/TEST-1",
      prompt: "follow your CLAUDE.md",
      effort: "high",
      mcpConfigPath: "/work/TEST-1/mcp.json",
      strictMcpConfig: true,
    }).args).toEqual([
      "follow your CLAUDE.md",
      "--effort", "high",
      "--permission-mode", "bypassPermissions",
      "--mcp-config", "/work/TEST-1/mcp.json",
      "--strict-mcp-config",
    ]);
  });

  test("BUTCHR-453: a definition without strictMcpConfig set produces no such flag", () => {
    expect(buildAgentStartParams({
      provider: "claude",
      name: "butchr-test-1",
      paneId: "w1:p1",
      cwd: "/work/TEST-1",
      prompt: "follow your CLAUDE.md",
      effort: "high",
      mcpConfigPath: "/work/TEST-1/mcp.json",
    }).args).not.toContain("--strict-mcp-config");
  });

  test.each([undefined, "test-model"])("builds an interactive AGY launch with model %s and pane-owned cwd", (model) => {
    expect(buildAgentStartParams({
      provider: "agy",
      name: "agy-worker",
      paneId: "w1:p3",
      cwd: "/work dir/TEST-3",
      prompt: "follow your AGENTS.md",
      ...(model ? { model } : {}),
      timeoutMs: 30_000,
    })).toEqual({
      kind: "agy",
      name: "agy-worker",
      pane_id: "w1:p3",
      timeout_ms: 30_000,
      args: [
        "--prompt-interactive", "follow your AGENTS.md",
        ...(model ? ["--model", model] : []),
      ],
    });
  });

  test.each([false, true])("AGY permission skipping is explicitly %s", (skipPermissions) => {
    const launch: AgyAgentLaunch = {
      provider: "agy",
      name: "agy-worker",
      paneId: "w1:p3",
      cwd: "/work dir/TEST-3",
      prompt: "follow your AGENTS.md",
      model: "test-model",
      timeoutMs: 30_000,
      skipPermissions,
    };
    expect(buildAgentStartParams(launch)).toEqual({
      kind: "agy",
      name: "agy-worker",
      pane_id: "w1:p3",
      timeout_ms: 30_000,
      args: [
        "--prompt-interactive", "follow your AGENTS.md",
        "--model", "test-model",
        ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
      ],
    });
  });

  test("builds isolated Codex MCP and trust configuration for Herdr", () => {
    const result = buildAgentStartParams({
      provider: "codex",
      name: "butchr-test-2",
      paneId: "w1:p2",
      cwd: "/work dir/TEST-2",
      prompt: "follow your AGENTS.md",
      model: "gpt-test",
      mcpServers: [{ name: "butchr", url: "http://localhost:7717/mcp", headers: {
        "x-issue": "TEST-2",
        "x-butchr-provider": "codex",
        "x-quoted": "a \"quoted\" value",
      } }],
      disabledMcpServers: [
        { name: "yappr", transport: "stdio" },
        { name: "other", transport: "streamable_http" },
      ],
    });

    expect(result.kind).toBe("codex");
    expect(result.name).toBe("butchr-test-2");
    expect(result.pane_id).toBe("w1:p2");
    expect(result.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    const configs = result.args!.flatMap((value, index, all) => value === "--config" ? [all[index + 1]!] : []);
    expect(Bun.TOML.parse(configs[0]!)).toEqual({ mcp_servers: { butchr: {
      url: "http://localhost:7717/mcp",
      enabled: true,
      http_headers: {
        "x-issue": "TEST-2",
        "x-butchr-provider": "codex",
        "x-quoted": "a \"quoted\" value",
      },
    } } });
    expect(Bun.TOML.parse(configs[1]!)).toEqual({ projects: { "/work dir/TEST-2": { trust_level: "trusted" } } });
    expect(configs).toContain('mcp_servers.yappr={enabled=false,command="false"}');
    expect(configs).toContain('mcp_servers.other={enabled=false,url="http://127.0.0.1:9/disabled"}');
  });

  // FACTORY-571/FACTORY-573: on win32, herdr joins a Codex pane's argv into one
  // PowerShell `Start-Process -ArgumentList` string; the re-parse eats the `"`
  // (and un-doubles the `\`) a TOML basic string relies on. TOML literal strings
  // (single-quoted, no escapes) carry neither, so they survive intact.
  describe.each([
    ["a drive-letter cwd", "C:\\Users\\zippy\\butchr-workspaces\\FACTORY-571"],
    ["a UNC cwd", "\\\\server\\share\\ws\\FACTORY-571"],
  ])("win32 Codex --config values for %s", (_label, cwd) => {
    function win32Configs(overrides: Partial<CodexAgentLaunch> = {}) {
      const result = buildAgentStartParams({
        provider: "codex",
        name: "butchr-test-win",
        paneId: "w1:p2",
        cwd,
        prompt: "follow your AGENTS.md",
        mcpServers: [{ name: "butchr", url: "http://localhost:7717/mcp", headers: {
          "x-issue": "TEST-2",
          "x-butchr-provider": "codex",
        } }],
        disabledMcpServers: [
          { name: "yappr", transport: "stdio" },
          { name: "other", transport: "streamable_http" },
        ],
        ...overrides,
      }, "win32");
      return result.args!.flatMap((value, index, all) => value === "--config" ? [all[index + 1]!] : []);
    }

    test("no --config value contains a double quote, and the cwd's backslashes are not doubled", () => {
      const configs = win32Configs();
      expect(configs.length).toBeGreaterThan(0);
      for (const config of configs) expect(config).not.toContain('"');
      const projectsConfig = configs.find((config) => config.startsWith("projects="))!;
      // JSON.stringify would double every backslash; a TOML literal string does no
      // escape processing, so the cwd's own backslash count survives unchanged.
      const backslashesInConfig = projectsConfig.split("\\").length - 1;
      const backslashesInCwd = cwd.split("\\").length - 1;
      expect(backslashesInConfig).toBe(backslashesInCwd);
    });

    test("each --config value round-trips through Bun.TOML.parse to the intended table", () => {
      const configs = win32Configs();
      const [mcpConfig, projectsConfig, yapprConfig, otherConfig] = configs;
      expect(Bun.TOML.parse(mcpConfig!)).toEqual({ mcp_servers: { butchr: {
        url: "http://localhost:7717/mcp",
        enabled: true,
        http_headers: { "x-issue": "TEST-2", "x-butchr-provider": "codex" },
      } } });
      expect(Bun.TOML.parse(projectsConfig!)).toEqual({ projects: { [cwd]: { trust_level: "trusted" } } });
      expect(Bun.TOML.parse(yapprConfig!)).toEqual({ mcp_servers: { yappr: { enabled: false, command: "false" } } });
      expect(Bun.TOML.parse(otherConfig!)).toEqual({ mcp_servers: { other: { enabled: false, url: "http://127.0.0.1:9/disabled" } } });
    });

    test("the projects key is character-for-character equal to the input cwd", () => {
      const configs = win32Configs();
      const parsed = Bun.TOML.parse(configs[1]!) as { projects: Record<string, unknown> };
      expect(Object.keys(parsed.projects)).toEqual([cwd]);
    });
  });

  test("win32 linux argv stays available: platform defaults to process.platform, and an explicit linux request is unaffected by win32 support", () => {
    const linuxArgs = buildAgentStartParams({
      provider: "codex",
      name: "butchr-test-2",
      paneId: "w1:p2",
      cwd: "/work dir/TEST-2",
      prompt: "follow your AGENTS.md",
      model: "gpt-test",
      mcpServers: [{ name: "butchr", url: "http://localhost:7717/mcp" }],
    }, "linux").args;
    expect(linuxArgs).toContain('--config');
    const configs = linuxArgs!.flatMap((value, index, all) => value === "--config" ? [all[index + 1]!] : []);
    expect(configs).toEqual([
      'mcp_servers.butchr={ url = "http://localhost:7717/mcp", enabled = true }',
      'projects={"/work dir/TEST-2"={trust_level="trusted"}}',
    ]);
  });

  test("a value containing a single quote cannot be encoded as a win32 TOML literal string and throws a clear, actionable error", () => {
    expect(() => buildAgentStartParams({
      provider: "codex",
      name: "test",
      paneId: "p",
      cwd: "C:\\Users\\it's-mine\\ws",
      prompt: "go",
      mcpServers: [],
    }, "win32")).toThrow(/single quote/);
  });

  test("rejects unsafe MCP names before constructing a CLI argument", () => {
    expect(() => buildAgentStartParams({
      provider: "codex",
      name: "test",
      paneId: "p",
      cwd: "/work",
      prompt: "go",
      mcpServers: [{ name: "bad.name", url: "http://localhost" }],
    })).toThrow("Unsupported MCP server name");
  });
});
