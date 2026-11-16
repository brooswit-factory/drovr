import { describe, expect, test } from "bun:test";
import { buildAgentStartParams, buildProviderLaunchArgs, checkManagedAgentArgv, inventoryCodexMcpServers, managedAgentProviderOfProcess, parseCodexMcpInventory, OLLAMA_CLAUDE_MODELS, ollamaPullArgv, pullOllamaModel, type AgyAgentLaunch, type CodexAgentLaunch, type OllamaAgentLaunch } from "../src/index.js";

describe("provider-owned agent launch plans", () => {
  test("recognizes managed providers from executable or process name", () => {
    expect(managedAgentProviderOfProcess({ argv: ["/usr/bin/claude"] })).toBe("claude");
    expect(managedAgentProviderOfProcess({ argv: ["node"], name: "codex" })).toBe("codex");
    expect(managedAgentProviderOfProcess({ argv: ["/home/worker/.local/bin/agy"] })).toBe("agy");
    expect(managedAgentProviderOfProcess({ name: "agy" })).toBe("agy");
    expect(managedAgentProviderOfProcess({ argv: ["fish"], name: "fish" })).toBeUndefined();
  });

  test("FACTORY-1050: recognizes only `ollama launch claude ...`, never a bare or differently-subcommanded ollama process", () => {
    expect(managedAgentProviderOfProcess({ argv: ["/usr/local/bin/ollama", "launch", "claude", "--model", "qwen3.5:4b"] })).toBe("ollama");
    expect(managedAgentProviderOfProcess({ argv: ["node"], name: "ollama launch claude" })).toBeUndefined();
    expect(managedAgentProviderOfProcess({ argv: ["ollama", "pull", "qwen3.5:4b"] })).toBeUndefined();
    expect(managedAgentProviderOfProcess({ argv: ["ollama", "run", "qwen3.5:4b"] })).toBeUndefined();
    expect(managedAgentProviderOfProcess({ argv: ["ollama"] })).toBeUndefined();
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

  test("FACTORY-579: Codex bypass-flag comparison is bidirectional", () => {
    const bypassExpected = ["--cd", "/w", "--dangerously-bypass-approvals-and-sandbox", "--config", "a"];
    const bypassObserved = ["--cd", "/w", "--dangerously-bypass-approvals-and-sandbox", "--config", "a"];
    // Unchanged states: both agree bypass is on, or both agree it's off.
    expect(checkManagedAgentArgv(bypassExpected, bypassObserved)).toEqual({ ok: true });
    const manual = ["--cd", "/w"];
    expect(checkManagedAgentArgv(manual, manual)).toEqual({ ok: true });

    // manual -> YOLO: expected gained the flag, observed still lacks it.
    expect(checkManagedAgentArgv(bypassExpected, manual)).toEqual({
      ok: false,
      reason: "argv lacks --dangerously-bypass-approvals-and-sandbox, --config a",
    });

    // YOLO -> manual: expected dropped the flag, observed still carries it.
    expect(checkManagedAgentArgv(manual, bypassObserved)).toEqual({
      ok: false,
      reason: "argv has unwanted --dangerously-bypass-approvals-and-sandbox",
    });
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

  test("FACTORY-1050: OLLAMA_CLAUDE_MODELS is exactly the three authorized literal strings, in order, including the unusual qwen3.8:27b spelling", () => {
    expect(OLLAMA_CLAUDE_MODELS).toEqual(["qwen3.5:4b", "gemma4:12b", "qwen3.8:27b"]);
  });

  test.each(OLLAMA_CLAUDE_MODELS)("FACTORY-1050: builds the exact `ollama launch claude --model %s ...` argv, preserving the Claude harness's own flags unmodified", (model) => {
    const launch: OllamaAgentLaunch = {
      provider: "ollama",
      name: "butchr-test-ollama",
      paneId: "w1:p4",
      cwd: "/work/TEST-4",
      prompt: "follow your CLAUDE.md",
      model,
      effort: "high",
      mcpConfigPath: "/work/TEST-4/mcp.json",
      developmentChannels: ["server:butchr"],
      timeoutMs: 30_000,
    };
    expect(buildAgentStartParams(launch)).toEqual({
      kind: "ollama",
      name: "butchr-test-ollama",
      pane_id: "w1:p4",
      timeout_ms: 30_000,
      args: [
        "launch", "claude", "--model", model,
        "follow your CLAUDE.md",
        "--effort", "high",
        "--permission-mode", "bypassPermissions",
        "--mcp-config", "/work/TEST-4/mcp.json",
        "--dangerously-load-development-channels=server:butchr",
      ],
    });
  });

  test("FACTORY-1050: an explicit ollama permissionMode and strictMcpConfig forward exactly like a direct Claude launch", () => {
    expect(buildAgentStartParams({
      provider: "ollama",
      name: "butchr-test-ollama",
      paneId: "w1:p4",
      cwd: "/work/TEST-4",
      prompt: "follow your CLAUDE.md",
      model: "gemma4:12b",
      effort: "low",
      mcpConfigPath: "/work/TEST-4/mcp.json",
      permissionMode: "acceptEdits",
      strictMcpConfig: true,
    }).args).toEqual([
      "launch", "claude", "--model", "gemma4:12b",
      "follow your CLAUDE.md",
      "--effort", "low",
      "--permission-mode", "acceptEdits",
      "--mcp-config", "/work/TEST-4/mcp.json",
      "--strict-mcp-config",
    ]);
  });

  test("FACTORY-1050: buildProviderLaunchArgs treats `ollama` identically to `claude` (same underlying harness, same flags)", () => {
    const inputs = { mcpConfigPath: "/w/mcp.json", developmentChannels: ["server:butchr"] };
    expect(buildProviderLaunchArgs("ollama", inputs)).toEqual(buildProviderLaunchArgs("claude", inputs));
  });

  test.each(OLLAMA_CLAUDE_MODELS)("FACTORY-1050: ollamaPullArgv(%s) is the literal, never-shell-interpolated `ollama pull <model>` argv", (model) => {
    expect(ollamaPullArgv(model)).toEqual(["ollama", "pull", model]);
  });

  test("FACTORY-1050: pullOllamaModel runs the pull argv through the injected runner and reports success without ever touching a real process", async () => {
    const calls: Array<readonly string[]> = [];
    const result = await pullOllamaModel("qwen3.5:4b", async (argv) => {
      calls.push(argv);
      return { exitCode: 0 };
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([["ollama", "pull", "qwen3.5:4b"]]);
  });

  test("FACTORY-1050: pullOllamaModel reports a clear, non-throwing failure on a nonzero pull exit code", async () => {
    const result = await pullOllamaModel("gemma4:12b", async () => ({ exitCode: 1, stderr: "pull model manifest: file does not exist" }));
    expect(result).toEqual({
      ok: false,
      reason: 'ollama pull gemma4:12b failed (exit code 1): pull model manifest: file does not exist',
    });
  });

  test("FACTORY-1050: pullOllamaModel reports a clear failure, never throws, even when the runner itself throws (e.g. ollama not installed)", async () => {
    const result = await pullOllamaModel("qwen3.8:27b", async () => { throw new Error("spawn ENOENT"); });
    expect(result).toEqual({ ok: false, reason: "ollama pull qwen3.8:27b failed to start: spawn ENOENT" });
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

  test("FACTORY-574: a header VALUE containing a double quote cannot be encoded as a win32 TOML literal string and throws a clear, actionable error", () => {
    expect(() => buildAgentStartParams({
      provider: "codex",
      name: "test",
      paneId: "p",
      cwd: "C:\\Users\\win\\ws",
      prompt: "go",
      mcpServers: [{ name: "butchr", url: "http://localhost:7717/mcp", headers: {
        "x-quoted": "a \"quoted\" value",
      } }],
    }, "win32")).toThrow(/double quote/);
  });

  test("FACTORY-574: a header KEY containing a double quote cannot be encoded as a win32 TOML literal string and throws a clear, actionable error", () => {
    expect(() => buildAgentStartParams({
      provider: "codex",
      name: "test",
      paneId: "p",
      cwd: "C:\\Users\\win\\ws",
      prompt: "go",
      mcpServers: [{ name: "butchr", url: "http://localhost:7717/mcp", headers: {
        'x-"quoted"-key': "value",
      } }],
    }, "win32")).toThrow(/double quote/);
  });

  test("FACTORY-574: a value containing a raw newline cannot be encoded as a win32 TOML literal string and throws a clear, actionable error", () => {
    expect(() => buildAgentStartParams({
      provider: "codex",
      name: "test",
      paneId: "p",
      cwd: "C:\\Users\\win\\ws",
      prompt: "go",
      mcpServers: [{ name: "butchr", url: "http://localhost:7717/mcp", headers: {
        "x-multiline": "line one\nline two",
      } }],
    }, "win32")).toThrow(/control character/);
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
