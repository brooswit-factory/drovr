import { readlink } from "node:fs/promises";
import type { ManagedAgentProvider } from "./agent-runtime.js";

/**
 * A provider condition that stops every agent on a host, not one turn. Each
 * kind names what was measured and the one act that clears it, so a host
 * reports the cause instead of a launch or a reply that silently never came.
 */
export type BlockingCondition =
  /**
   * Measured on servyboi 2026-09-17: all 16 agents died on their first call
   * with an assistant record `error: "authentication_failed"`, text
   * "Login expired · Please run /login". Cleared by `startClaudeLogin`.
   */
  | { kind: "login-expired"; provider: ManagedAgentProvider; detail: string }
  /**
   * Measured 2026-09-18: after the CLI upgraded under a running daemon, every
   * background session settled "(crashed): daemon binary was deleted
   * (upgrade in progress)". `claude daemon stop --any --keep-workers` did NOT
   * preserve sessions through the next takeover (adopt reported dead=7), so
   * Drovr reports this and never stops the daemon on a caller's behalf.
   */
  | { kind: "daemon-binary-replaced"; provider: "claude"; detail: string; daemonPid?: number; daemonVersion?: string }
  /**
   * Measured 2026-09-18, claude 2.1.276: a background session in a directory
   * whose `.mcp.json` names an unapproved server sits `state: "blocked"` on
   * "New MCP server found in this project". A workspace `settings.local.json`
   * approval is ignored while the directory is untrusted; launching with
   * `mcpServersApproved` (Claude's `--settings`) clears it.
   */
  | { kind: "mcp-approval-prompt"; provider: "claude"; detail: string };

export type BlockingConditionKind = BlockingCondition["kind"];

// Both spellings observed in this host's own transcripts under `error: "authentication_failed"`.
const LOGIN_EXPIRED = /Login expired · Please run \/login|Failed to authenticate\. API Error: 401/;
const DAEMON_BINARY_REPLACED = /daemon binary was deleted \(upgrade in progress\)/;
const MCP_APPROVAL_PROMPT = /New\s*MCP\s*server\s*found\s*in\s*this\s*project/;

/** Terminal escapes: CSI (colour, cursor) and OSC (hyperlinks, titles). */
export function stripTerminalEscapes(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g, "");
}

/** The line of `text` that matched, trimmed, as the evidence a report carries. */
function matchedLine(text: string, pattern: RegExp): string {
  return text.split(/\r?\n/).find((line) => pattern.test(line))?.trim() ?? text.trim();
}

/**
 * Recognise a host-wide blocking condition in any provider text Drovr reads
 * back: launch output, a daemon log line, `claude logs`, a pane. Undefined
 * for anything else, including an ordinary failure, which stays the caller's.
 */
export function classifyBlockingText(provider: ManagedAgentProvider, raw: string): BlockingCondition | undefined {
  const text = stripTerminalEscapes(raw);
  if (DAEMON_BINARY_REPLACED.test(text)) {
    if (provider !== "claude") return undefined;
    return { kind: "daemon-binary-replaced", provider, detail: matchedLine(text, DAEMON_BINARY_REPLACED) };
  }
  if (LOGIN_EXPIRED.test(text)) return { kind: "login-expired", provider, detail: matchedLine(text, LOGIN_EXPIRED) };
  if (provider === "claude" && MCP_APPROVAL_PROMPT.test(text)) {
    return { kind: "mcp-approval-prompt", provider, detail: "New MCP server found in this project" };
  }
  return undefined;
}

/**
 * Recognise a blocking condition in one Claude transcript record. Claude tags
 * an API failure structurally (`isApiErrorMessage`, `error`), so this reads
 * the tag rather than the prose; a tool result that merely quotes the prose is
 * a user record and never matches.
 */
export function classifyClaudeTranscriptRecord(record: unknown): BlockingCondition | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = record as Record<string, unknown>;
  if (value.type !== "assistant" || value.isApiErrorMessage !== true || value.error !== "authentication_failed") return undefined;
  const content = (value.message as { content?: unknown } | undefined)?.content;
  const detail = Array.isArray(content)
    ? content.flatMap((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text] : []).join(" ").trim()
    : "";
  return { kind: "login-expired", provider: "claude", detail: detail || "authentication_failed" };
}

/** Everything a daemon probe needs from the host; injectable for tests. */
export interface ClaudeDaemonProbeDeps {
  /** Runs `claude <args>` with plain output and resolves its result. */
  runClaude(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** `readlink /proc/<pid>/exe`; resolves undefined where that is unreadable. */
  readExecutable(pid: number): Promise<string | undefined>;
}

export type ClaudeDaemonState =
  | { running: false }
  | { running: true; pid: number; version?: string; executable?: string; binaryReplaced: boolean };

const defaultDaemonProbeDeps = (run: ClaudeDaemonProbeDeps["runClaude"]): ClaudeDaemonProbeDeps => ({
  runClaude: run,
  readExecutable: async (pid) => {
    try { return await readlink(`/proc/${pid}/exe`); } catch { return undefined; }
  },
});

/**
 * Read the shared Claude daemon's pid and version from `claude daemon status`
 * and check whether the executable it is running still exists. Linux reports a
 * replaced executable as `<path> (deleted)`, which is exactly the state that
 * crashes every background spawn it serves.
 */
export async function probeClaudeDaemon(deps: Partial<ClaudeDaemonProbeDeps> = {}): Promise<ClaudeDaemonState> {
  const resolved = { ...defaultDaemonProbeDeps(deps.runClaude ?? runPlainClaude), ...deps };
  const status = await resolved.runClaude(["daemon", "status"]);
  const text = stripTerminalEscapes(status.stdout);
  const pid = Number(text.match(/^pid:\s*(\d+)/m)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return { running: false };
  const version = text.match(/^version:\s*(\S+)/m)?.[1];
  const executable = await resolved.readExecutable(pid);
  return {
    running: true,
    pid,
    ...(version ? { version } : {}),
    ...(executable ? { executable } : {}),
    binaryReplaced: executable?.endsWith(" (deleted)") ?? false,
  };
}

/** The daemon as a blocking condition, or undefined when it is absent or sound. */
export function daemonBlockingCondition(state: ClaudeDaemonState): BlockingCondition | undefined {
  if (!state.running || !state.binaryReplaced) return undefined;
  return {
    kind: "daemon-binary-replaced",
    provider: "claude",
    detail: `claude daemon pid ${state.pid}${state.version ? ` (${state.version})` : ""} is running a deleted executable ${state.executable ?? ""}`.trim(),
    daemonPid: state.pid,
    ...(state.version ? { daemonVersion: state.version } : {}),
  };
}

/**
 * `claude auth status` reports only what is stored locally: a token the server
 * has since expired still reads `loggedIn: true`. It proves a logged-out host,
 * never a working one; an expired login is only proven by a refused call
 * (`classifyClaudeTranscriptRecord`).
 */
export async function claudeLoggedIn(run: ClaudeDaemonProbeDeps["runClaude"] = runPlainClaude): Promise<boolean> {
  const result = await run(["auth", "status", "--json"]);
  try {
    return (JSON.parse(result.stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * The caller's environment minus FORCE_COLOR. Claude Code sets FORCE_COLOR in
 * every session, and `claude` then colours even piped output, so anything a
 * process inside a session runs and parses came back wrapped in escapes.
 * NO_COLOR is not set: a launched session inherits it and would lose colour in
 * its own terminal.
 */
export function plainOutputEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const plain: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (key !== "FORCE_COLOR" && value !== undefined) plain[key] = value;
  return plain;
}

/** Runs `claude <args>` with plain output, stdin closed, both streams drained. */
export async function runPlainClaude(args: readonly string[], cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["claude", ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    env: plainOutputEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
