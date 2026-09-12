import type { ParamsOf } from "@brooswit/herdr-sdk";

export type ManagedAgentProvider = "claude" | "codex";

export interface ManagedAgentProcess {
  argv?: readonly string[] | null;
  name?: string | null;
}

const executableName = (value: string): string => value.replace(/\\/g, "/").split("/").pop() ?? value;

export function managedAgentProviderOfProcess(process: ManagedAgentProcess): ManagedAgentProvider | undefined {
  const command = executableName(process.argv?.[0] ?? "");
  const name = executableName(process.name ?? "");
  if (command === "claude" || name === "claude") return "claude";
  if (command === "codex" || name === "codex") return "codex";
  return undefined;
}

export type ManagedAgentArgvCheck = { ok: true } | { ok: false; reason: string };

const REQUIRED_CLAUDE_FLAGS = ["--permission-mode", "--mcp-config", "--dangerously-load-development-channels"] as const;

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function checkManagedAgentArgv(expected: readonly string[], observed: readonly string[]): ManagedAgentArgvCheck {
  const missing: string[] = [];
  if (expected.includes("--dangerously-bypass-approvals-and-sandbox")) {
    if (!observed.includes("--dangerously-bypass-approvals-and-sandbox")) missing.push("--dangerously-bypass-approvals-and-sandbox");
    for (const flag of ["--cd", "--config"]) {
      const wants = expected.flatMap((value, index) => value === flag ? [expected[index + 1]] : []);
      const values = observed.flatMap((value, index) => value === flag ? [observed[index + 1]] : []);
      for (const want of wants) if (!values.includes(want)) missing.push(`${flag} ${want}`);
    }
  }
  for (const flag of REQUIRED_CLAUDE_FLAGS) {
    const want = flagValue(expected, flag);
    if (want !== undefined && flagValue(observed, flag) !== want) missing.push(`${flag} ${want}`);
  }
  return missing.length ? { ok: false, reason: `argv lacks ${missing.join(", ")}` } : { ok: true };
}

export interface McpServerLaunchConfig {
  name: string;
  url: string;
  headers?: Readonly<Record<string, string>>;
}

export interface DisabledMcpServer {
  name: string;
  transport: "stdio" | "streamable_http";
}

export interface CodexMcpInventoryProbeResult {
  exitCode: number;
  stdout: { toString(): string } | string;
}

export type CodexMcpInventory =
  | { ok: true; servers: DisabledMcpServer[] }
  | { ok: false; reason: string };

export function parseCodexMcpInventory(output: string, excludedNames: readonly string[] = []): DisabledMcpServer[] {
  const servers: unknown = JSON.parse(output);
  if (!Array.isArray(servers) || servers.some((server) => !server || typeof server.name !== "string")) {
    throw new Error("Invalid Codex MCP inventory");
  }
  const excluded = new Set(excludedNames);
  return servers.filter((server) => !excluded.has(server.name)).map((server) => {
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) throw new Error("Unsupported Codex MCP server name; cannot isolate workers");
    const transport = server.transport?.type;
    if (transport !== "stdio" && transport !== "streamable_http") throw new Error("Unknown Codex MCP transport");
    return { name: server.name, transport };
  });
}

export function inventoryCodexMcpServers(
  excludedNames: readonly string[] = [],
  probe: () => CodexMcpInventoryProbeResult = () => Bun.spawnSync(
    ["codex", "mcp", "list", "--json"],
    { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
  ),
): CodexMcpInventory {
  try {
    const result = probe();
    if (result.exitCode !== 0) throw new Error("inventory failed");
    return { ok: true, servers: parseCodexMcpInventory(result.stdout.toString(), excludedNames) };
  } catch {
    return {
      ok: false,
      reason: "Codex MCP inventory unavailable or invalid; fix `codex mcp list --json` for the service user and retry;",
    };
  }
}

interface AgentLaunchBase {
  provider: ManagedAgentProvider;
  name: string;
  paneId: string;
  cwd: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
}

export interface ClaudeAgentLaunch extends AgentLaunchBase {
  provider: "claude";
  effort: string;
  mcpConfigPath: string;
  permissionMode?: string;
  developmentChannels?: readonly string[];
}

export interface CodexAgentLaunch extends AgentLaunchBase {
  provider: "codex";
  mcpServers: readonly McpServerLaunchConfig[];
  disabledMcpServers?: readonly DisabledMcpServer[];
  trustWorkspace?: boolean;
  bypassApprovalsAndSandbox?: boolean;
}

export type ManagedAgentLaunch = ClaudeAgentLaunch | CodexAgentLaunch;

function safeName(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Unsupported MCP server name ${JSON.stringify(name)}`);
  }
  return name;
}

function inlineToml(value: unknown): string {
  return JSON.stringify(value);
}

function codexMcpArg(server: McpServerLaunchConfig): string {
  const headers = server.headers && Object.keys(server.headers).length
    ? `, http_headers = ${inlineToml(server.headers)}`
    : "";
  return `mcp_servers.${safeName(server.name)}={ url = ${inlineToml(server.url)}${headers}, enabled = true }`;
}

function disabledCodexMcpArg(server: DisabledMcpServer): string {
  return `mcp_servers.${safeName(server.name)}={enabled=false,${server.transport === "stdio"
    ? 'command="false"'
    : 'url="http://127.0.0.1:9/disabled"'}}`;
}

/**
 * Translate application intent into Herdr's low-level agent.start contract.
 * Herdr owns the pane and process; Drovr owns provider-specific CLI shape.
 */
export function buildAgentStartParams(launch: ManagedAgentLaunch): ParamsOf<"agent.start"> {
  const common = {
    name: launch.name,
    pane_id: launch.paneId,
    ...(launch.timeoutMs === undefined ? {} : { timeout_ms: launch.timeoutMs }),
  };

  if (launch.provider === "claude") {
    return {
      ...common,
      kind: "claude",
      args: [
        launch.prompt,
        ...(launch.model ? ["--model", launch.model] : []),
        "--effort", launch.effort,
        "--permission-mode", launch.permissionMode ?? "bypassPermissions",
        "--mcp-config", launch.mcpConfigPath,
        ...(launch.developmentChannels?.length
          ? ["--dangerously-load-development-channels", ...launch.developmentChannels]
          : []),
      ],
    };
  }

  return {
    ...common,
    kind: "codex",
    args: [
      launch.prompt,
      ...(launch.model ? ["--model", launch.model] : []),
      "--cd", launch.cwd,
      ...(launch.bypassApprovalsAndSandbox === false ? [] : ["--dangerously-bypass-approvals-and-sandbox"]),
      ...launch.mcpServers.flatMap((server) => ["--config", codexMcpArg(server)]),
      ...(launch.trustWorkspace === false
        ? []
        : ["--config", `projects={${inlineToml(launch.cwd)}={trust_level="trusted"}}`]),
      ...(launch.disabledMcpServers ?? []).flatMap((server) => ["--config", disabledCodexMcpArg(server)]),
    ],
  };
}
