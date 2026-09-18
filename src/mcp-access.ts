import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ManagedAgentProvider } from "./agent-runtime.js";

/**
 * One declaration of intent — "this agent may use yappr" — rendered into each
 * vendor's own dialect here, so a caller states it once and never learns that
 * Claude spells it `enabledMcpjsonServers` in a workspace file, AGY spells it
 * `permissions.allow: ["mcp(yappr/*)"]` in a home file, and Codex spells it on
 * the command line. This is the same shape the runner already uses for
 * permission modes; MCP access was the part still left to every caller.
 *
 * Each vendor reads all of this at PROCESS START. A write to a running agent
 * changes nothing, and a Claude session already blocked on an unanswerable
 * approval prompt can never be rescued by a later write — which is why
 * `mcpAccessProvisioning` reports `restartRequired` rather than pretending a
 * write took effect, and why a provider switch must provision the TARGET
 * vendor before its first process starts.
 */
export interface McpServerAccess {
  /** The server's name as its own MCP configuration file names it. */
  name: string;
  /** Tools the agent may call; omitted means every tool the server offers. */
  tools?: readonly string[];
  /** Whether the agent should receive this server's notifications. */
  notifications?: boolean;
  /**
   * How to reach the server, for vendors that keep server definitions in a
   * file of their own (AGY). Omitted, only access is provisioned and the
   * vendor's existing definition is left as it is.
   */
  definition?: McpServerDefinition;
}

/** A server definition as `.mcp.json` states it, in no vendor's dialect. */
export type McpServerDefinition =
  | { type: "http"; url: string; headers?: Readonly<Record<string, string>> }
  | { type: "stdio"; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> };

const stringRecord = (value: unknown, what: string): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((v) => typeof v !== "string")) {
    throw new Error(`${what} must map names to strings`);
  }
  return value as Record<string, string>;
};

/**
 * The servers a `.mcp.json` defines, in the neutral shape above. An entry with
 * a `url` is http (also when it says `"type": "http"` or `"sse"`); one with a
 * `command` is stdio. Anything else is refused rather than guessed at.
 */
export function mcpServersFromMcpJson(json: unknown): Record<string, McpServerDefinition> {
  const servers = (json as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error(".mcp.json has no mcpServers object");
  const out: Record<string, McpServerDefinition> = {};
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    safeName(name);
    const entry = raw as { url?: unknown; command?: unknown; args?: unknown; headers?: unknown; env?: unknown };
    if (typeof entry?.url === "string") {
      const headers = stringRecord(entry.headers, `${name}.headers`);
      out[name] = headers === undefined ? { type: "http", url: entry.url } : { type: "http", url: entry.url, headers };
    } else if (typeof entry?.command === "string") {
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string"))) {
        throw new Error(`${name}.args must be a list of strings`);
      }
      const stdio: { type: "stdio"; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> } = { type: "stdio", command: entry.command };
      if (entry.args !== undefined) stdio.args = entry.args as string[];
      const env = stringRecord(entry.env, `${name}.env`);
      if (env !== undefined) stdio.env = env;
      out[name] = stdio;
    } else {
      throw new Error(`MCP server ${name} has neither a url nor a command`);
    }
  }
  return out;
}

/**
 * One server in AGY's own `mcp_config.json` dialect. Measured with
 * `agy mcp add` on agy 1.2.6 (2026-09-18): an http server is
 * `{serverUrl, headers, disabled}`, not `url`; a stdio server is
 * `{command, args, env, disabled}`.
 */
export function agyMcpServerEntry(definition: McpServerDefinition): Record<string, unknown> {
  if (definition.type === "http") {
    return { disabled: false, ...(definition.headers ? { headers: { ...definition.headers } } : {}), serverUrl: definition.url };
  }
  return {
    ...(definition.args ? { args: [...definition.args] } : {}),
    command: definition.command,
    disabled: false,
    ...(definition.env ? { env: { ...definition.env } } : {}),
  };
}

export interface McpAccessDeclaration {
  servers: readonly McpServerAccess[];
  /** Workspace whose per-project vendor settings this declaration governs. */
  cwd: string;
  /** The agent's own home, for vendors that keep permissions there. Defaults to this user's. */
  home?: string;
  /** How the agent's process runs; decides whether notifications can reach it at all. */
  runtime?: McpRuntime;
}

/**
 * What the agent that is running right now was actually started with.
 *
 * `notificationServers` left undefined means "not known", which is a third
 * answer, not a quiet zero. Treating unknown as unsubscribed would demand a
 * fresh launch on every call and never converge; treating it as subscribed
 * would reproduce exactly the bug this exists to catch. So unknown is reported
 * as unverified and the caller is told it cannot claim a subscription.
 */
export interface RunningMcpAccess {
  /** Servers whose channels its CURRENT process was launched with, if any. */
  notificationServers?: readonly string[];
}

/** One vendor settings file, and the exact keys this declaration governs in it. */
export interface McpSettingsEdit {
  path: string;
  /** Applied to the file's parsed contents; every other key is preserved. */
  apply: (settings: Record<string, unknown>) => Record<string, unknown>;
  /** Human-readable statement of what this edit asserts, for reporting. */
  describes: string;
}

export interface McpAccessProvisioning {
  /** Settings a vendor reads at process start, which must exist before it starts. */
  edits: readonly McpSettingsEdit[];
  /** MCP servers whose notifications the process must be started with. */
  notificationServers: readonly string[];
  /** Whether a subscription can reach this agent at all; see notificationSupport. */
  notifications: NotificationSupport;
}

/**
 * What it takes for a change to actually reach the agent.
 *
 * `restart` is enough for enablement, which every vendor re-reads at process
 * start. A subscription needs more: it is a launch-time argument, and a
 * respawn carries no arguments ever, so only a fresh launch or a fork can
 * apply one. Reporting that difference is the whole point — a caller that
 * respawns to pick up a subscription gets a session that looks restarted and
 * is still not subscribed.
 */
export type McpRestartKind = "none" | "restart" | "fresh-launch";

/**
 * How the agent's process runs. Only a Claude Code session with a terminal can
 * render a channel notification frame; `--print` has no acceptor for one and
 * skips channels entirely.
 */
export type McpRuntime = "interactive" | "print";

export type NotificationSupport =
  | {
      supported: true;
      /** Conditions that must ALL hold; none of them is checkable after start. */
      requires: readonly string[];
      /** What remains unguaranteed even when they do hold. */
      caveat: string;
    }
  | { supported: false; reason: string };

/**
 * Whether a notification subscription can reach this agent at all.
 *
 * Rendering a channel frame requires Claude Code specifically, launched with a
 * terminal and its channels, and a human accepting a permission prompt per
 * frame. That is the ceiling. AGY and Codex are the wrong runtime and can
 * never be woken this way, and headless Claude has no acceptor — so Drovr says
 * so here instead of emitting a flag that does nothing and letting a caller
 * believe a subscription exists.
 */
export function notificationSupport(provider: ManagedAgentProvider, runtime: McpRuntime = "interactive"): NotificationSupport {
  if (provider !== "claude") {
    return { supported: false, reason: `${provider} cannot render a channel notification frame; only Claude Code does` };
  }
  if (runtime === "print") {
    return { supported: false, reason: "headless Claude (--print) has no acceptor for a channel frame and skips channels" };
  }
  return {
    supported: true,
    requires: [
      "Claude Code with a terminal, not --print",
      "launched with the server's development channel",
      "a fresh launch or fork, never a respawn",
    ],
    caveat: "each frame still needs a human to accept its prompt, so an unattended session may never render one",
  };
}

const NAME = /^[A-Za-z0-9_-]+$/;

function safeName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Unsupported MCP server name ${JSON.stringify(name)}`);
  return name;
}

function union(existing: unknown, additions: readonly string[]): string[] {
  const kept = Array.isArray(existing) ? existing.filter((entry): entry is string => typeof entry === "string") : [];
  return [...new Set([...kept, ...additions])];
}

/** AGY names a whole server `mcp(<server>/*)` and one tool `mcp(<server>/<tool>)`. */
function agyPermissions(server: McpServerAccess): string[] {
  const name = safeName(server.name);
  if (!server.tools) return [`mcp(${name}/*)`];
  return server.tools.map((tool) => `mcp(${name}/${safeName(tool)})`);
}

/**
 * What one vendor needs on disk, and at process start, for this declaration to
 * hold. Pure: it decides and describes, and writes nothing.
 */
export function mcpAccessProvisioning(
  provider: ManagedAgentProvider,
  declaration: McpAccessDeclaration,
): McpAccessProvisioning {
  if (!isAbsolute(declaration.cwd)) throw new Error("MCP access declaration needs an absolute workspace");
  const names = declaration.servers.map((server) => safeName(server.name));
  const notificationServers = declaration.servers.filter((server) => server.notifications).map((server) => server.name);
  const notifications = notificationServers.length === 0
    ? ({ supported: false, reason: "this declaration asks for no notifications" } as NotificationSupport)
    : notificationSupport(provider, declaration.runtime ?? "interactive");
  if (names.length === 0) return { edits: [], notificationServers: [], notifications };

  if (provider === "claude") {
    // Measured: without this, the session sits blocked on an approval prompt it
    // cannot be answered out of, and its identity never registers at all.
    return {
      notificationServers,
      notifications,
      edits: [{
        path: join(declaration.cwd, ".claude", "settings.local.json"),
        describes: `claude may use ${names.join(", ")} from this workspace's .mcp.json`,
        apply: (settings) => ({ ...settings, enabledMcpjsonServers: union(settings.enabledMcpjsonServers, names) }),
      }],
    };
  }

  if (provider === "agy") {
    // Measured: without this, headless AGY auto-denies every MCP call and still
    // answers SUCCESS with an empty response (see AgyDeniedActionsError).
    const allow = declaration.servers.flatMap(agyPermissions);
    const home = declaration.home ?? homedir();
    const defined = declaration.servers.filter((server) => server.definition !== undefined);
    const definitions: McpSettingsEdit[] = defined.length === 0 ? [] : [{
      // AGY keeps its server definitions in its home, not in the workspace, so
      // a declaration that carries them writes them there. Servers it does not
      // name, and every other key, are left as they are.
      path: join(home, ".gemini", "config", "mcp_config.json"),
      describes: `agy reaches ${defined.map((server) => server.name).join(", ")} as defined`,
      apply: (config) => {
        const existing = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
          ? config.mcpServers as Record<string, unknown>
          : {};
        const rendered = Object.fromEntries(defined.map((server) => [safeName(server.name), agyMcpServerEntry(server.definition!)]));
        return { ...config, mcpServers: { ...existing, ...rendered } };
      },
    }];
    return {
      notificationServers,
      notifications,
      edits: [...definitions, {
        path: join(home, ".gemini", "antigravity-cli", "settings.json"),
        describes: `agy may call ${allow.join(", ")}`,
        apply: (settings) => {
          const permissions = settings.permissions && typeof settings.permissions === "object" && !Array.isArray(settings.permissions)
            ? settings.permissions as Record<string, unknown>
            : {};
          return { ...settings, permissions: { ...permissions, allow: union(permissions.allow, allow) } };
        },
      }],
    };
  }

  // Codex takes its MCP servers as `--config` arguments at start (see
  // buildAgentStartParams); it keeps no per-workspace permission file.
  return { notificationServers, notifications, edits: [] };
}

export interface McpSettingsIo {
  /** Resolves undefined when the file is absent; anything else is an error. */
  readSettings: (path: string) => Promise<string | undefined>;
  writeSettings: (path: string, contents: string) => Promise<void>;
}

/** Reads and writes a vendor settings file as the agent's own user, refusing symlinks. */
export const realMcpSettingsIo: McpSettingsIo = {
  readSettings: async (path) => {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      if (!(await file.stat()).isFile()) throw new Error("Vendor settings must be a regular file");
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  },
  writeSettings: async (path, contents) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Vendor settings must be a regular file");
      await file.truncate();
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
  },
};

export interface McpAccessApplied {
  /** True when a file changed, which is exactly when a running agent is stale. */
  changed: boolean;
  /**
   * A running agent read its MCP configuration at start, so a change here does
   * not reach it. It is restarted, never merely written to.
   */
  restartRequired: boolean;
  /** How the running agent must come back for this to reach it. */
  restart: McpRestartKind;
  /** Files actually rewritten, for reporting. */
  written: readonly string[];
  notificationServers: readonly string[];
  /** Subscriptions asked for that this provider and runtime cannot deliver. */
  notifications: NotificationSupport;
  /**
   * True when a subscription was asked for and could be delivered, but the
   * caller did not say what the running process was launched with. Nothing can
   * claim this agent is subscribed until a launch is observed.
   */
  subscriptionUnverified: boolean;
}

/**
 * Bring one vendor's settings into line with the declaration, preserving every
 * key this declaration does not govern. Idempotent: a settings file that
 * already grants the access is left untouched and reports `changed: false`, so
 * a caller never restarts an agent that did not need it.
 */
export async function applyMcpAccess(
  provider: ManagedAgentProvider,
  declaration: McpAccessDeclaration,
  io: McpSettingsIo = realMcpSettingsIo,
  running: RunningMcpAccess = {},
): Promise<McpAccessApplied> {
  const plan = mcpAccessProvisioning(provider, declaration);
  const written: string[] = [];
  for (const edit of plan.edits) {
    const raw = await io.readSettings(edit.path);
    let settings: Record<string, unknown> = {};
    if (raw !== undefined && raw.trim().length > 0) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch { throw new Error(`Cannot read ${edit.path} as JSON; refusing to overwrite settings this cannot parse`); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${edit.path} is not a JSON object; refusing to overwrite it`);
      }
      settings = parsed as Record<string, unknown>;
    }
    const next = edit.apply(settings);
    const before = raw === undefined ? undefined : JSON.stringify(settings);
    if (before === JSON.stringify(next)) continue;
    await io.writeSettings(edit.path, `${JSON.stringify(next, null, 2)}\n`);
    written.push(edit.path);
  }
  // A subscription the current process was not launched with can only arrive
  // through a fresh launch; a respawn carries no arguments at all.
  const wanted = plan.notifications.supported ? plan.notificationServers : [];
  const known = running.notificationServers !== undefined;
  const held = new Set(running.notificationServers ?? []);
  const unsubscribed = known && wanted.some((server) => !held.has(server));
  const restart: McpRestartKind = unsubscribed ? "fresh-launch" : written.length > 0 ? "restart" : "none";
  return {
    changed: written.length > 0,
    restartRequired: restart !== "none",
    restart,
    written,
    notificationServers: plan.notificationServers,
    notifications: plan.notifications,
    subscriptionUnverified: wanted.length > 0 && !known,
  };
}

export interface IdentityReleaseOptions {
  /** True once the previous holder is confirmed gone. Asked repeatedly. */
  released: () => Promise<boolean>;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class IdentityStillHeldError extends Error {
  readonly code = "identity_still_held";
  constructor(readonly elapsedMs: number) {
    super(`The previous holder still held the identity after ${elapsedMs}ms; refusing to declare the new agent ready`);
    this.name = "IdentityStillHeldError";
  }
}

/**
 * Wait until the previous holder of a single-holder identity is CONFIRMED
 * gone. Measured: a notification service allows one connection per identity,
 * and when a bridge child died its registration was not reaped — every new
 * bridge was refused, the model saw zero tools, and the symptom looked exactly
 * like broken MCP configuration. Only a full service restart cleared it, at
 * the cost of every other identity's registration.
 *
 * So this asks a real question and fails loudly on a deadline. It is
 * deliberately not a sleep: a sleep long enough to usually work is also a
 * sleep that silently declares readiness when the holder is still there.
 */
export async function awaitIdentityRelease(options: IdentityReleaseOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pollMs = options.pollMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const started = now();
  const deadline = started + timeoutMs;
  for (;;) {
    if (await options.released()) return;
    if (now() >= deadline) throw new IdentityStillHeldError(Math.max(0, Math.round(now() - started)));
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

export interface McpRestartDeps<T> extends Partial<IdentityReleaseOptions> {
  /** Stops the agent currently holding the identity. */
  stop: () => Promise<void>;
  /**
   * Starts the agent again, only after the identity is confirmed free. It is
   * told which kind of start this has to be: `fresh-launch` means a respawn
   * cannot satisfy it, because the change is a launch-time argument.
   */
  start: (kind: Exclude<McpRestartKind, "none">) => Promise<T>;
  /** Confirms the previous holder is gone; required, because a sleep cannot. */
  released: () => Promise<boolean>;
  io?: McpSettingsIo;
}

export interface McpAccessChange<T> {
  applied: McpAccessApplied;
  /** Absent when nothing changed and the running agent was therefore left alone. */
  restarted?: T;
}

/**
 * Set the CURRENT agent's MCP access and restart it, in that order, behind a
 * verified identity release.
 *
 * The ordering is the whole point. Provisioning happens BEFORE the new process
 * starts, because every vendor reads it at start. The restart happens because a
 * write alone reaches no running process. And the start waits on a real check
 * that the previous holder released the identity, because a single-holder
 * identity that was never reaped makes the new agent come up toolless while
 * reporting success.
 */
export async function setMcpAccess<T>(
  provider: ManagedAgentProvider,
  declaration: McpAccessDeclaration,
  deps: McpRestartDeps<T>,
  running: RunningMcpAccess = {},
): Promise<McpAccessChange<T>> {
  const applied = await applyMcpAccess(provider, declaration, deps.io ?? realMcpSettingsIo, running);
  if (applied.restart === "none") return { applied };
  await deps.stop();
  await awaitIdentityRelease({
    released: deps.released,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
  return { applied, restarted: await deps.start(applied.restart) };
}

/**
 * Provision the TARGET vendor's MCP access before its first process starts,
 * then start it — the same ordering the conversation lifecycle already keeps
 * for native identity and history import. Out of order, the first turn on the
 * new provider comes up with no tools and, on AGY, silently succeeds with
 * empty output.
 */
export async function switchProviderMcpAccess<T>(
  target: ManagedAgentProvider,
  declaration: McpAccessDeclaration,
  deps: { start: (kind: Exclude<McpRestartKind, "none">) => Promise<T>; io?: McpSettingsIo }
    & Partial<Pick<McpRestartDeps<T>, "released" | "timeoutMs" | "pollMs" | "now" | "sleep">>,
): Promise<McpAccessChange<T>> {
  const applied = await applyMcpAccess(target, declaration, deps.io ?? realMcpSettingsIo);
  if (deps.released) {
    await awaitIdentityRelease({
      released: deps.released,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
  }
  // A switch always starts a new process, so its subscriptions apply.
  return { applied, restarted: await deps.start("fresh-launch") };
}
