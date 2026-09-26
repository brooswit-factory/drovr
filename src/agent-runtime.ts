import type { ParamsOf } from "@brooswit/herdr-sdk";

export type ManagedAgentProvider = "claude" | "codex" | "agy";

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
  if (command === "agy" || name === "agy") return "agy";
  return undefined;
}

export type ManagedAgentArgvCheck = { ok: true } | { ok: false; reason: string };

const CLAUDE_DEVELOPMENT_CHANNELS_FLAG = "--dangerously-load-development-channels";
const CLAUDE_STRICT_MCP_FLAG = "--strict-mcp-config";
const REQUIRED_CLAUDE_FLAGS = ["--permission-mode", "--mcp-config", CLAUDE_DEVELOPMENT_CHANNELS_FLAG] as const;

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Every value of a variadic flag, up to the next flag or the end of argv. */
function flagValues(argv: readonly string[], flag: string): readonly string[] | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const rest = argv.slice(index + 1);
  const next = rest.findIndex((value) => value.startsWith("--"));
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Every development channel a Claude argv names, in either spelling: the
 * `--flag=server:a` form Drovr emits, and the variadic `--flag server:a
 * server:b` form a process launched by an older build still carries.
 */
function developmentChannelValues(argv: readonly string[]): readonly string[] | undefined {
  const joined = argv.flatMap((value) => value.startsWith(`${CLAUDE_DEVELOPMENT_CHANNELS_FLAG}=`) ? [value.slice(CLAUDE_DEVELOPMENT_CHANNELS_FLAG.length + 1)] : []);
  const spaced = flagValues(argv, CLAUDE_DEVELOPMENT_CHANNELS_FLAG) ?? [];
  const all = [...joined, ...spaced];
  return all.length || argv.includes(CLAUDE_DEVELOPMENT_CHANNELS_FLAG) ? all : undefined;
}

/**
 * Union development channel names in caller order, keeping the first mention of
 * each. Merging rather than replacing is what lets a request add a channel to a
 * launch that already configures others, without either side knowing the other.
 */
export function mergeDevelopmentChannels(
  ...lists: readonly (readonly string[] | undefined)[]
): readonly string[] {
  return [...new Set(lists.flatMap((list) => list ? [...list] : []))];
}

export function checkManagedAgentArgv(expected: readonly string[], observed: readonly string[]): ManagedAgentArgvCheck {
  const missing: string[] = [];
  // Valueless, like --dangerously-bypass-approvals-and-sandbox below: presence-only, no following value to compare.
  if (expected.includes(CLAUDE_STRICT_MCP_FLAG) && !observed.includes(CLAUDE_STRICT_MCP_FLAG)) missing.push(CLAUDE_STRICT_MCP_FLAG);
  if (expected.includes("--dangerously-bypass-approvals-and-sandbox")) {
    if (!observed.includes("--dangerously-bypass-approvals-and-sandbox")) missing.push("--dangerously-bypass-approvals-and-sandbox");
    for (const flag of ["--cd", "--config"]) {
      const wants = expected.flatMap((value, index) => value === flag ? [expected[index + 1]] : []);
      const values = observed.flatMap((value, index) => value === flag ? [observed[index + 1]] : []);
      for (const want of wants) if (!values.includes(want)) missing.push(`${flag} ${want}`);
    }
  }
  for (const flag of REQUIRED_CLAUDE_FLAGS) {
    if (flag === CLAUDE_DEVELOPMENT_CHANNELS_FLAG) {
      // Variadic: a live process missing any one configured channel has drifted.
      const wanted = developmentChannelValues(expected);
      if (!wanted?.length) continue;
      const seen = new Set(developmentChannelValues(observed) ?? []);
      const absent = wanted.filter((channel) => !seen.has(channel));
      if (absent.length) missing.push(`${flag} ${absent.join(" ")}`);
      continue;
    }
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

function safeName(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Unsupported MCP server name ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * What a caller configures for a session, in its own vocabulary: which MCP
 * configuration the session reads, and which MCP servers it must receive
 * notifications from. No field here names a provider or a CLI flag, so a
 * caller that only knows "this session talks to yappr" never learns Claude's
 * spelling for it.
 */
export interface ProviderLaunchInputs {
  /** MCP configuration file the session launches against. */
  mcpConfigPath?: string;
  /** MCP servers whose notifications must reach the session. */
  mcpNotificationServers?: readonly string[];
  /** Channel names a caller already holds spelled out; merged with the above. */
  developmentChannels?: readonly string[];
  /**
   * Servers from the workspace's own MCP file the session may start without
   * asking. Measured on claude 2.1.276: in an untrusted directory Claude
   * ignores the workspace's own approval file, and a background session sits
   * blocked on "New MCP server found in this project" until a human answers.
   * An approval given at launch holds regardless of trust.
   */
  mcpServersApproved?: readonly string[];
  /**
   * BUTCHR-453: Claude only. `true` emits `--strict-mcp-config` alongside
   * `--mcp-config`, so Claude Code loads ONLY the servers named in
   * `mcpConfigPath` — no project- or user-level `.mcp.json` discovery.
   * Providers with no such concept ignore it, same discipline as every
   * other field here.
   */
  strictMcpConfig?: boolean;
}

/**
 * Claude subscribes a session to an MCP server's notifications through a
 * development channel named after the server. That spelling is Claude's, so it
 * lives here rather than in any caller. The name must be a plain identifier:
 * the channel prefix already keeps it out of flag position, but a name carrying
 * whitespace or punctuation would not round-trip as one channel token.
 */
const claudeDevelopmentChannel = (server: string): string => `server:${safeName(server)}`;

/**
 * Every channel a launch asks for: the ones named outright plus one per MCP
 * server whose notifications were requested, de-duplicated in caller order.
 */
export function developmentChannelsOf(inputs: ProviderLaunchInputs): readonly string[] {
  return mergeDevelopmentChannels(
    inputs.developmentChannels,
    inputs.mcpNotificationServers?.map(claudeDevelopmentChannel),
  );
}

/**
 * Translate neutral launch inputs into one provider's CLI arguments. This is
 * the whole of Drovr's provider-flag knowledge for MCP and channels: a caller
 * that spawns a provider CLI itself appends these and spells nothing of its
 * own. Providers with no development-channel concept return no such flag
 * rather than refusing the caller.
 *
 * Each channel is its own `--dangerously-load-development-channels=server:x`.
 * The variadic space-separated form is not safe: measured on claude 2.1.276,
 * `claude --bg` reads the flag's value as the session's first prompt (its job
 * `intent`), so a launch with `... server:rocketr --bg` began its life with
 * the user turn "server:rocketr" and never registered the channel. Joined with
 * `=`, no argv splitter can take the value for a positional.
 */
export function buildProviderLaunchArgs(
  provider: ManagedAgentProvider,
  inputs: ProviderLaunchInputs,
): string[] {
  if (provider !== "claude") return [];
  const channels = developmentChannelsOf(inputs);
  const approved = [...new Set(inputs.mcpServersApproved?.map(safeName) ?? [])];
  return [
    ...(inputs.mcpConfigPath === undefined ? [] : ["--mcp-config", inputs.mcpConfigPath]),
    ...(inputs.strictMcpConfig ? [CLAUDE_STRICT_MCP_FLAG] : []),
    ...(approved.length ? ["--settings", JSON.stringify({ enabledMcpjsonServers: approved })] : []),
    ...channels.map((channel) => `${CLAUDE_DEVELOPMENT_CHANNELS_FLAG}=${channel}`),
  ];
}

interface AgentLaunchBase {
  provider: ManagedAgentProvider;
  name: string;
  paneId: string;
  cwd: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  /**
   * Provider-neutral MCP configuration file path. Callers state the intent once;
   * each provider adapter below decides whether and how to spell it on the CLI.
   */
  mcpConfigPath?: string;
  /**
   * Provider-neutral development channel names. Providers without a development
   * channel concept accept and ignore them rather than rejecting the caller.
   */
  developmentChannels?: readonly string[];
  /** MCP servers whose notifications must reach this agent; see ProviderLaunchInputs. */
  mcpNotificationServers?: readonly string[];
}

export interface ClaudeAgentLaunch extends AgentLaunchBase {
  provider: "claude";
  effort: string;
  /** Claude always launches against an explicit MCP configuration. */
  mcpConfigPath: string;
  permissionMode?: string;
  /**
   * BUTCHR-453: emits `--strict-mcp-config` alongside `--mcp-config` when
   * `true`, telling Claude Code to load ONLY the MCP servers named in that
   * file — no project-level or user-level `.mcp.json` discovery. Distinct
   * from `assertNoInheritedMcpConfig` (the caller-side check butchr already
   * has): that refuses a spawn if a project-level `.mcp.json` sits in an
   * ancestor directory; this flag closes the wider gap it explicitly does
   * NOT cover — user-level MCP config Claude Code would otherwise still
   * discover regardless of caller-side directory hygiene. Absent/`false`
   * means today's behaviour exactly: no flag emitted, ordinary discovery.
   */
  strictMcpConfig?: boolean;
}

export interface CodexAgentLaunch extends AgentLaunchBase {
  provider: "codex";
  mcpServers: readonly McpServerLaunchConfig[];
  disabledMcpServers?: readonly DisabledMcpServer[];
  trustWorkspace?: boolean;
  bypassApprovalsAndSandbox?: boolean;
}

export interface AgyAgentLaunch extends AgentLaunchBase {
  provider: "agy";
  /** Skip AGY permission prompts only when explicitly enabled by the caller. */
  skipPermissions?: boolean;
}

export type ManagedAgentLaunch = ClaudeAgentLaunch | CodexAgentLaunch | AgyAgentLaunch;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringMap(value: Readonly<Record<string, string>>): string {
  return `{ ${Object.entries(value)
    .map(([key, entry]) => `${tomlString(key)} = ${tomlString(entry)}`)
    .join(", ")} }`;
}

function codexMcpArg(server: McpServerLaunchConfig): string {
  const headers = server.headers && Object.keys(server.headers).length
    ? `, http_headers = ${tomlStringMap(server.headers)}`
    : "";
  return `mcp_servers.${safeName(server.name)}={ url = ${tomlString(server.url)}${headers}, enabled = true }`;
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
        ...buildProviderLaunchArgs("claude", launch),
      ],
    };
  }

  if (launch.provider === "agy") {
    // AGY inherits cwd from the pane and MCP configuration externally (including
    // stdio bridges); this adapter does not supply cwd or MCP CLI overrides.
    // Neutral mcpConfigPath and developmentChannels are accepted and deliberately
    // unspelled here: AGY has no equivalent flags, and Claude's must never leak.
    return {
      ...common,
      kind: "agy",
      args: [
        "--prompt-interactive", launch.prompt,
        ...(launch.model ? ["--model", launch.model] : []),
        ...(launch.skipPermissions === true ? ["--dangerously-skip-permissions"] : []),
      ],
    };
  }

  // Codex receives MCP servers structurally through --config; the neutral
  // mcpConfigPath and developmentChannels are accepted without Claude coupling.
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
        : ["--config", `projects={${tomlString(launch.cwd)}={trust_level="trusted"}}`]),
      ...(launch.disabledMcpServers ?? []).flatMap((server) => ["--config", disabledCodexMcpArg(server)]),
    ],
  };
}
