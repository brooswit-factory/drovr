import type { ParamsOf } from "@brooswit/herdr-sdk";

export type ManagedAgentProvider = "claude" | "codex" | "agy" | "ollama";

/**
 * FACTORY-1050: the EXACT three model choices John authorized for the
 * "Ollama Claude" launcher — no fourth, no normalization, no substitution.
 * `"qwen3.8:27b"` (jira comment 54276) is the CONFIRMED spelling, superseding
 * an earlier `"qwen.3.8:27b"` that a registry lookup (comment 54275) flagged
 * as a likely typo — never silently "correct" this list again without an
 * equivalent explicit confirmation; preserve it byte-for-byte. This is the
 * one place both repos source it from (butchr's `AGENT_HARNESSES`-adjacent
 * catalog, `rule-form-catalog.ts`, duplicates this literal list for the same
 * leaf-module/no-node-import reason `AGENT_HARNESSES` itself already
 * duplicates Drovr's `ManagedAgentProvider` union — see that module's own
 * top comment).
 */
export const OLLAMA_CLAUDE_MODELS = ["qwen3.5:4b", "gemma4:12b", "qwen3.8:27b"] as const;
export type OllamaClaudeModel = (typeof OLLAMA_CLAUDE_MODELS)[number];

/**
 * FACTORY-1050 (jira comment 54274): the desired semantics are
 * `ollama pull <model> && ollama launch claude --model <model>` — but as a
 * LITERAL argv array for a SEPARATE, dedicated process, never a shell
 * string handed to `/bin/sh -c`. No value ever gets concatenated into a
 * command line here, so there is nothing for `model` to inject into even
 * before it's checked against `OLLAMA_CLAUDE_MODELS` — the safety property
 * holds independent of that allowlist, which is what "safe argv/process
 * sequencing, not arbitrary shell interpolation" (the ticket's own words)
 * asks for.
 */
export function ollamaPullArgv(model: OllamaClaudeModel): string[] {
  return ["ollama", "pull", model];
}

/** The result of running `ollamaPullArgv`'s argv as a real process — the ONLY shape `pullOllamaModel` below needs from whatever runs it. */
export interface OllamaPullProcessResult {
  exitCode: number;
  /** Trailing diagnostic text, when the pull failed; never required on success. */
  stderr?: string;
}

export type OllamaPullResult = { ok: true } | { ok: false; reason: string };

/**
 * Pulls the selected model and reports success/failure explicitly — never
 * throws on a failed pull, so a caller cannot forget to check before
 * proceeding to `buildAgentStartParams`'s `ollama` branch. `run` is
 * injectable so tests cover success/failure/ordering with a mocked process
 * runner and never invoke a real `ollama pull` (this ticket's own explicit
 * exclusion); the default implementation is the only place that would ever
 * shell out for real, and even that never goes through a shell — `Bun.spawn`
 * with a literal argv array, identical in spirit to `inventoryCodexMcpServers`'s
 * own `Bun.spawnSync` default above, but async (`spawnSync`
 * would block the daemon's event loop for as long as a real pull takes).
 */
export async function pullOllamaModel(
  model: OllamaClaudeModel,
  run: (argv: readonly string[]) => Promise<OllamaPullProcessResult> = async (argv) => {
    const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
    // Drain BOTH pipes concurrently with the exit wait, not after it: a real
    // `ollama pull` writes a large, long-running progress stream to stdout.
    // Reading either pipe only once `exited` resolves is a classic deadlock
    // — once the OS pipe buffer fills, the child blocks on its own write()
    // forever, so it never exits, so a read that starts only after exit
    // never starts at all. `Response(...).text()` consumes a stream AS it
    // arrives, so running it alongside `proc.exited` (not sequenced after)
    // is what keeps the child's writes unblocked regardless of how verbose
    // or long the real pull is.
    const [exitCode, , stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode === 0) return { exitCode };
    return { exitCode, stderr: stderrText };
  },
): Promise<OllamaPullResult> {
  let result: OllamaPullProcessResult;
  try {
    result = await run(ollamaPullArgv(model));
  } catch (error) {
    // A thrown runner (e.g. ENOENT: `ollama` not installed/on PATH) is just
    // as much "cannot launch" as a nonzero exit — reported the same way,
    // never left to crash the caller.
    return { ok: false, reason: `ollama pull ${model} failed to start: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim();
    return {
      ok: false,
      reason: `ollama pull ${model} failed (exit code ${result.exitCode})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
    };
  }
  return { ok: true };
}

export interface ManagedAgentProcess {
  argv?: readonly string[] | null;
  name?: string | null;
}

const executableName = (value: string): string => value.replace(/\\/g, "/").split("/").pop() ?? value;

/**
 * FACTORY-1050: `ollama` alone is not enough — the bare `ollama` CLI has
 * many unrelated subcommands (`pull`, `run`, `serve`, …), and only
 * `ollama launch claude ...` is the managed Claude-harness launcher this
 * module knows how to build/compare argv for. Checked positionally
 * (`argv[1]`/`argv[2]`), not via `includes`, so a future `ollama launch
 * codex` (if Ollama ever ships one) is never misclassified as this provider.
 */
function isOllamaClaudeLaunch(process: ManagedAgentProcess): boolean {
  return (process.argv?.[1] === "launch" && process.argv?.[2] === "claude");
}

export function managedAgentProviderOfProcess(process: ManagedAgentProcess): ManagedAgentProvider | undefined {
  const command = executableName(process.argv?.[0] ?? "");
  const name = executableName(process.name ?? "");
  if (command === "claude" || name === "claude") return "claude";
  if (command === "codex" || name === "codex") return "codex";
  if (command === "agy" || name === "agy") return "agy";
  if ((command === "ollama" || name === "ollama") && isOllamaClaudeLaunch(process)) return "ollama";
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
  const unwanted: string[] = [];
  // Valueless, like --dangerously-bypass-approvals-and-sandbox below: presence-only, no following value to compare.
  if (expected.includes(CLAUDE_STRICT_MCP_FLAG) && !observed.includes(CLAUDE_STRICT_MCP_FLAG)) missing.push(CLAUDE_STRICT_MCP_FLAG);
  if (expected.includes("--dangerously-bypass-approvals-and-sandbox")) {
    if (!observed.includes("--dangerously-bypass-approvals-and-sandbox")) missing.push("--dangerously-bypass-approvals-and-sandbox");
    for (const flag of ["--cd", "--config"]) {
      const wants = expected.flatMap((value, index) => value === flag ? [expected[index + 1]] : []);
      const values = observed.flatMap((value, index) => value === flag ? [observed[index + 1]] : []);
      for (const want of wants) if (!values.includes(want)) missing.push(`${flag} ${want}`);
    }
  } else if (observed.includes("--dangerously-bypass-approvals-and-sandbox")) {
    // YOLO -> manual: expected dropped the flag but the live process still carries it,
    // i.e. a pane that should have fallen back into manual-approval mode after a
    // definition edit is still running unattended in bypass mode.
    unwanted.push("--dangerously-bypass-approvals-and-sandbox");
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
  if (!missing.length && !unwanted.length) return { ok: true };
  const reason = [
    missing.length ? `argv lacks ${missing.join(", ")}` : undefined,
    unwanted.length ? `argv has unwanted ${unwanted.join(", ")}` : undefined,
  ].filter((part): part is string => part !== undefined).join("; ");
  return { ok: false, reason };
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
  // FACTORY-1050: `ollama launch claude` is a thin launcher in front of the
  // SAME real Claude harness `claude` itself is, so it takes the identical
  // MCP/development-channel flags, spelled identically. Never add
  // Ollama-specific flag knowledge here; see `buildAgentStartParams`'s
  // `ollama` branch below for where those flags are PLACED in argv relative
  // to `ollama launch claude --model <model>`.
  if (provider !== "claude" && provider !== "ollama") return [];
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

/**
 * FACTORY-1050: the fourth, narrow launcher — `ollama launch claude --model
 * <model>` fronting the SAME real Claude harness `ClaudeAgentLaunch` above
 * drives, which is why every field below mirrors that interface exactly
 * (required `model`, narrowed to the three authorized literals instead of a
 * free string; required `effort`/`mcpConfigPath`; optional
 * `permissionMode`/`strictMcpConfig`) rather than inventing Ollama-specific
 * concepts. Deliberately NOT given resume-in-place support: Drovr's
 * `--resume` mechanism is documented elsewhere (`checkManagedAgentArgv`'s
 * callers, butchr's `herd.ts`) as verified for `claude` only, and this
 * ticket's explicit exclusions forbid any live Ollama/model testing that
 * could verify `ollama launch claude --resume <id>` actually behaves the
 * same way — so, like `codex`/`agy` today, an `ollama` session is always a
 * fresh launch, never resumed in place. This is a scope boundary, not an
 * oversight.
 */
export interface OllamaAgentLaunch extends AgentLaunchBase {
  provider: "ollama";
  model: OllamaClaudeModel;
  effort: string;
  /** Claude always launches against an explicit MCP configuration, same as `ClaudeAgentLaunch.mcpConfigPath`. */
  mcpConfigPath: string;
  permissionMode?: string;
  /** See `ClaudeAgentLaunch.strictMcpConfig`'s own doc comment — identical semantics, same underlying harness. */
  strictMcpConfig?: boolean;
}

export type ManagedAgentLaunch = ClaudeAgentLaunch | CodexAgentLaunch | AgyAgentLaunch | OllamaAgentLaunch;

/**
 * On win32, herdr joins a Codex pane's argv into a single PowerShell
 * `Start-Process -ArgumentList` string; that re-parse eats the escaped `"`
 * a TOML basic string relies on (see FACTORY-571). A TOML *literal* string
 * (single-quoted, no escape processing) carries no such quote and needs no
 * backslash doubling, so it survives that hop intact. It cannot represent a
 * value containing `'` or `"` — a `"` would pass through the literal string
 * unescaped and reintroduce the exact PowerShell re-parse bug this exists to
 * avoid (see FACTORY-572) — nor a raw newline/CR/other control character
 * (TOML literal strings are single-line; tab is the only control character
 * they permit). Such values throw rather than silently falling back to a
 * basic string.
 */
function tomlString(value: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return JSON.stringify(value);
  if (value.includes("'")) {
    throw new Error(`Cannot encode ${JSON.stringify(value)} as a Windows-safe TOML literal string: it contains a single quote`);
  }
  if (value.includes('"')) {
    throw new Error(`Cannot encode ${JSON.stringify(value)} as a Windows-safe TOML literal string: it contains a double quote`);
  }
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
    throw new Error(`Cannot encode ${JSON.stringify(value)} as a Windows-safe TOML literal string: it contains a control character (e.g. a newline) that a single-line TOML literal string cannot hold`);
  }
  return `'${value}'`;
}

function tomlStringMap(value: Readonly<Record<string, string>>, platform: NodeJS.Platform): string {
  return `{ ${Object.entries(value)
    .map(([key, entry]) => `${tomlString(key, platform)} = ${tomlString(entry, platform)}`)
    .join(", ")} }`;
}

function codexMcpArg(server: McpServerLaunchConfig, platform: NodeJS.Platform): string {
  const headers = server.headers && Object.keys(server.headers).length
    ? `, http_headers = ${tomlStringMap(server.headers, platform)}`
    : "";
  return `mcp_servers.${safeName(server.name)}={ url = ${tomlString(server.url, platform)}${headers}, enabled = true }`;
}

function disabledCodexMcpArg(server: DisabledMcpServer, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `mcp_servers.${safeName(server.name)}={enabled=false,${server.transport === "stdio"
      ? "command='false'"
      : "url='http://127.0.0.1:9/disabled'"}}`;
  }
  return `mcp_servers.${safeName(server.name)}={enabled=false,${server.transport === "stdio"
    ? 'command="false"'
    : 'url="http://127.0.0.1:9/disabled"'}}`;
}

/**
 * Translate application intent into Herdr's low-level agent.start contract.
 * Herdr owns the pane and process; Drovr owns provider-specific CLI shape.
 */
export function buildAgentStartParams(
  launch: ManagedAgentLaunch,
  platform: NodeJS.Platform = process.platform,
): ParamsOf<"agent.start"> {
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

  if (launch.provider === "ollama") {
    // FACTORY-1050: the literal command John authorized —
    // `ollama launch claude --model <model>` — with the prompt and every
    // other Claude flag following exactly where they sit for a direct
    // `claude` launch (see `ClaudeAgentLaunch`'s branch above): the
    // underlying process IS the real Claude harness, so its own flag
    // grammar is unchanged, only prefixed by the `ollama launch claude
    // --model <model>` positionals that select which local model backs it.
    //
    // OPEN COMPATIBILITY QUESTION, not resolved here: whether `ollama
    // launch` itself requires a `--` delimiter before forwarding the rest
    // of argv to the wrapped harness (a pattern some wrapper CLIs use, e.g.
    // `npm run x -- --flag`) is UNVERIFIED — this ticket's own exclusions
    // forbid installing/running a real `ollama` binary to check its actual
    // passthrough grammar, and the ticket's own authorizing text gives only
    // the literal command above with no delimiter. Implemented EXACTLY as
    // authorized (no delimiter) rather than guessing one is needed; if a
    // real `ollama launch claude` does require `--` here, every flag below
    // would need to move after it — confirm against the real CLI (or its
    // documentation) before this path is ever used against a live install.
    // Not something a mocked test can settle either way.
    return {
      ...common,
      kind: "ollama",
      args: [
        "launch", "claude", "--model", launch.model,
        launch.prompt,
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
      ...launch.mcpServers.flatMap((server) => ["--config", codexMcpArg(server, platform)]),
      ...(launch.trustWorkspace === false
        ? []
        : ["--config", `projects={${tomlString(launch.cwd, platform)}={trust_level=${tomlString("trusted", platform)}}}`]),
      ...(launch.disabledMcpServers ?? []).flatMap((server) => ["--config", disabledCodexMcpArg(server, platform)]),
    ],
  };
}
