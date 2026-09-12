import { describe, expect, test } from "bun:test";
import { buildAgentStartParams, checkManagedAgentArgv, inventoryCodexMcpServers, managedAgentProviderOfProcess, parseCodexMcpInventory } from "../src/index.js";

describe("provider-owned agent launch plans", () => {
  test("recognizes managed providers from executable or process name", () => {
    expect(managedAgentProviderOfProcess({ argv: ["/usr/bin/claude"] })).toBe("claude");
    expect(managedAgentProviderOfProcess({ argv: ["node"], name: "codex" })).toBe("codex");
    expect(managedAgentProviderOfProcess({ argv: ["fish"], name: "fish" })).toBeUndefined();
  });

  test("checks provider-owned persistent launch arguments", () => {
    const expected = ["--permission-mode", "bypassPermissions", "--mcp-config", "/w/mcp.json", "--dangerously-load-development-channels", "server:butchr"];
    expect(checkManagedAgentArgv(expected, expected)).toEqual({ ok: true });
    expect(checkManagedAgentArgv(expected, ["--permission-mode", "bypassPermissions"])).toEqual({
      ok: false,
      reason: "argv lacks --mcp-config /w/mcp.json, --dangerously-load-development-channels server:butchr",
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
        "--dangerously-load-development-channels", "server:butchr",
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
