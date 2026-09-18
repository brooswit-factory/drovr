import type { ManagedAgentProvider } from "./agent-runtime.js";
import type { ProviderQuotaRefusal } from "./provider-fallback.js";
import { detectSessionLimitRefusal } from "./session-limit.js";
import { plainOutputEnv } from "./blocking-conditions.js";

/** Confirmed native CLI quota refusal, never inferred from arbitrary failures. */
export class ManagedConversationQuotaError extends Error {
  readonly provider = "claude" as const;
  readonly refusal: ProviderQuotaRefusal;

  constructor(refusal: ProviderQuotaRefusal) {
    super("Claude native conversation quota blocked");
    this.name = "ManagedConversationQuotaError";
    this.refusal = { ...refusal };
  }
}

export interface ManagedConversationResult {
  conversationId: string;
  response: string;
}

/**
 * AGY headless answers a turn whose tool calls were all denied with
 * `status: "SUCCESS"`, an EMPTY `response`, and the denials listed in
 * `denied_actions` — measured shape `{action: "mcp", display_name:
 * "CallMcpTool"}`. Parsed as a plain result, that is an assistant turn that
 * said nothing, and a host persists it as one; the actual cause (no
 * `permissions.allow` entry for the server) is invisible and every symptom
 * points at MCP configuration instead. Refusing it here turns that whole
 * class into one line of diagnosis.
 */
export class AgyDeniedActionsError extends Error {
  readonly provider = "agy" as const;
  /** The vendor's own display names, in the order AGY reported them. */
  readonly deniedActions: readonly string[];

  constructor(deniedActions: readonly string[]) {
    super(`AGY denied every action in this turn and returned an empty response: ${deniedActions.join(", ")}`);
    this.name = "AgyDeniedActionsError";
    this.deniedActions = [...deniedActions];
  }
}

/** The display names AGY reported as denied, or [] when it reported none. */
function deniedActions(value: Record<string, unknown>): string[] {
  const denied = value.denied_actions;
  if (!Array.isArray(denied)) return [];
  return denied.map((entry, index) => {
    const name = record(entry) ? entry.display_name ?? entry.action : undefined;
    return typeof name === "string" && name.length > 0 ? name : `denied action ${index + 1}`;
  });
}

export type RunProcess = (argv: readonly string[], cwd: string) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

/** Direct CLI transport; stdin is closed, both output streams are drained, and output is never coloured for parsing. */
export const runConversationProcess: RunProcess = async (argv, cwd) => {
  try {
    const child = Bun.spawn([...argv], { cwd, env: plainOutputEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } catch {
    throw new Error("Conversation process execution failed");
  }
};

export interface ManagedConversationRunnerOptions {
  provider: ManagedAgentProvider;
  cwd: string;
  /** "yolo", "plan", or otherwise "accept-edits", matching USRR's AGY behavior. */
  permissionMode?: string;
  run?: RunProcess;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/^[\s-]|[\s\0]/.test(value);
}

function json(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error("Conversation CLI returned invalid JSON"); }
}

function parseAgy(stdout: string): ManagedConversationResult {
  const value = json(stdout);
  if (!record(value) || value.status !== "SUCCESS" || !validId(value.conversation_id) || typeof value.response !== "string") {
    throw new Error("AGY returned an unsuccessful or incomplete conversation result");
  }
  // A SUCCESS that both said nothing and denied something is the denial, not a
  // turn. A denial alongside real output is left to the caller's own reading.
  const denied = deniedActions(value);
  if (denied.length > 0 && value.response.trim().length === 0) throw new AgyDeniedActionsError(denied);
  return { conversationId: value.conversation_id, response: value.response };
}

function parseClaude(stdout: string): ManagedConversationResult {
  const value = json(stdout);
  if (!record(value) || value.type !== "result" || value.subtype !== "success" || value.is_error !== false
    || !validId(value.session_id) || typeof value.result !== "string") {
    throw new Error("Claude returned an unsuccessful or incomplete conversation result");
  }
  return { conversationId: value.session_id, response: value.result };
}

function claudeQuota(stdout: string): ProviderQuotaRefusal | null {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return null; }
  // Measured --print JSON refusal: subtype remains success despite the API error.
  if (!record(value) || value.type !== "result" || value.subtype !== "success" || value.is_error !== true
    || value.terminal_reason !== "api_error" || value.api_error_status !== 429 || !validId(value.session_id)
    || typeof value.result !== "string" || /[\r\n]/.test(value.result)) return null;
  return detectSessionLimitRefusal(value.result, new Date());
}

function parseCodex(stdout: string): ManagedConversationResult {
  let conversationId: string | undefined;
  let response: string | undefined;
  let completed = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = json(line);
    if (!record(event) || typeof event.type !== "string") throw new Error("Codex returned an invalid conversation event");
    if (event.type === "error" || event.type === "turn.failed") throw new Error("Codex conversation turn failed");
    if (event.type === "thread.started") {
      if (!validId(event.thread_id) || conversationId !== undefined) throw new Error("Codex returned an invalid conversation ID");
      conversationId = event.thread_id;
    }
    if (event.type === "item.completed" && record(event.item) && event.item.type === "agent_message") {
      if (completed || typeof event.item.text !== "string") throw new Error("Codex returned an invalid conversation message");
      // Intermediate tool narration can also be an agent_message. Return the last one.
      response = event.item.text;
    }
    if (event.type === "turn.completed") {
      if (completed) throw new Error("Codex returned multiple conversation turns");
      completed = true;
    }
  }
  if (!conversationId || response === undefined || !completed) throw new Error("Codex returned an incomplete conversation result");
  return { conversationId, response };
}

/** Single-provider transport; ManagedConversationLifecycle owns selection and identity, with durable storage through its commit callback. */
export class ManagedConversationRunner {
  readonly provider: ManagedAgentProvider;
  private readonly cwd: string;
  private readonly mode: "accept-edits" | "plan" | "yolo";
  private readonly run: RunProcess;

  constructor(options: ManagedConversationRunnerOptions) {
    if (!["agy", "codex", "claude"].includes(options.provider)) throw new Error("Unsupported conversation provider");
    this.provider = options.provider;
    this.cwd = options.cwd;
    this.mode = options.permissionMode === "yolo" || options.permissionMode === "plan" ? options.permissionMode : "accept-edits";
    this.run = options.run ?? runConversationProcess;
  }

  private permissionArgs(interactive = false): string[] {
    if (this.provider === "codex") {
      if (this.mode === "yolo") return ["--dangerously-bypass-approvals-and-sandbox"];
      return ["--sandbox", this.mode === "plan" ? "read-only" : "workspace-write",
        "--ask-for-approval", interactive ? "on-request" : "never"];
    }
    if (this.provider === "claude") {
      if (this.mode === "yolo") return ["--dangerously-skip-permissions"];
      return ["--permission-mode", this.mode === "plan" ? "plan" : "acceptEdits"];
    }
    if (this.mode === "yolo") return ["--dangerously-skip-permissions"];
    return ["--mode", this.mode];
  }

  private messageArgv(text: string, conversationId?: string): string[] {
    const argv = [this.provider, ...this.permissionArgs()];
    if (this.provider === "codex") {
      argv.push("exec", "--json", "--skip-git-repo-check");
      if (conversationId) argv.push("resume", "--", conversationId, text);
      else argv.push("--", text);
    } else {
      argv.push("--output-format", "json");
      if (conversationId) argv.push(this.provider === "agy" ? "--conversation" : "--resume", conversationId);
      argv.push("--print");
      if (this.provider === "claude") argv.push("--");
      argv.push(text);
    }
    return argv;
  }

  async message(text: string, conversationId?: string): Promise<ManagedConversationResult> {
    if (conversationId !== undefined && !validId(conversationId)) throw new Error("Invalid conversation ID");
    const argv = this.messageArgv(text, conversationId);
    let processResult: Awaited<ReturnType<RunProcess>>;
    try { processResult = await this.run(argv, this.cwd); }
    catch { throw new Error(`${this.provider} conversation process failed`); }
    if (this.provider === "claude" && (processResult.exitCode === 0 || processResult.exitCode === 1)) {
      const refusal = claudeQuota(processResult.stdout);
      if (refusal) throw new ManagedConversationQuotaError(refusal);
    }
    if (processResult.exitCode !== 0) throw new Error(`${this.provider} conversation process exited unsuccessfully`);
    const result = this.provider === "agy" ? parseAgy(processResult.stdout)
      : this.provider === "codex" ? parseCodex(processResult.stdout) : parseClaude(processResult.stdout);
    if (conversationId !== undefined && result.conversationId !== conversationId) {
      throw new Error(`${this.provider} returned a different conversation ID while resuming`);
    }
    return result;
  }

  attachArgv(conversationId: string): string[] {
    if (!validId(conversationId)) throw new Error("Invalid conversation ID");
    if (this.provider === "codex") {
      return ["codex", ...this.permissionArgs(true), "--cd", this.cwd, "resume", "--", conversationId];
    }
    return [this.provider, ...this.permissionArgs(true), this.provider === "agy" ? "--conversation" : "--resume", conversationId];
  }
}
