import type { ParamsOf } from "@brooswit/herdr-sdk";

export type ManagedAgentProvider = "claude" | "codex";

export interface McpServerLaunchConfig {
  name: string;
  url: string;
  headers?: Readonly<Record<string, string>>;
}

export interface DisabledMcpServer {
  name: string;
  transport: "stdio" | "streamable_http";
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

