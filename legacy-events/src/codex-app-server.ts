import { instanceFreezeStore, watchInstanceFreeze, type InstanceFreezeStore } from './instance-freeze.js';
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ManagedConversationResult } from "./managed-conversation.js";

export interface CodexAppServerOptions {
  cwd: string;
  /** Stable host-namespaced identity; enables persistent operator freeze. */
  instanceId?: string;
  freezeStore?: InstanceFreezeStore;
  permissionMode?: string;
  model?: string;
  /** Overrides are scoped to this server; account configuration remains inherited. */
  config?: Readonly<Record<string, unknown>>;
  command?: readonly string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onNotification?: (method: string, params: unknown) => void;
}

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type ActiveTurn = { threadId: string; turnId?: string; response: string; resolve(value: ManagedConversationResult): void; reject(error: Error): void };
class RequestRefused extends Error {}

export interface AcceptedCodexTurn {
  conversationId: string;
  completed: Promise<ManagedConversationResult>;
}

/** One owned App Server and one loaded conversation, kept alive between messages. */
export class CodexAppServerRunner {
  private freezeWatch: ReturnType<typeof watchInstanceFreeze> | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private initialized: Promise<void> | undefined;
  private threadId: string | undefined;
  private active: ActiveTurn | undefined;
  private busy = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private failure: Error | undefined;

  constructor(private readonly options: CodexAppServerOptions) {}

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.active?.reject(error);
    this.active = undefined;
  }

  private initialize(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex App Server is closed"));
    if (this.failure) return Promise.reject(this.failure);
    if (this.options.instanceId && !this.freezeWatch) this.freezeWatch = watchInstanceFreeze(this.options.instanceId, () => this.close(), {...(this.options.freezeStore ? {store:this.options.freezeStore} : {}),onError: error => this.fail(error instanceof Error ? error : new Error(String(error)))});
    return this.initialized ??= (async () => {
      const command = this.options.command ?? ["codex", "app-server"];
      if (!command[0]) throw new Error("Codex command is empty");
      const child = spawn(command[0], command.slice(1), {
        cwd: this.options.cwd, env: this.options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      child.stderr.resume();
      child.stdin.on("error", () => this.fail(new Error("Codex App Server input closed; delivery may be uncertain")));
      child.on("error", () => this.fail(new Error("Codex App Server could not start")));
      child.on("exit", () => this.fail(new Error("Codex App Server exited; pending delivery may be uncertain")));
      createInterface({ input: child.stdout }).on("line", line => {
        try { this.receive(JSON.parse(line)); }
        catch { this.fail(new Error("Codex App Server returned an invalid protocol message")); child.kill(); }
      });
      await this.request("initialize", { clientInfo: { name: "drovr", version: "0.12.0" }, capabilities: { experimentalApi: true } });
      this.write({ method: "initialized", params: {} });
    })();
  }

  private write(message: unknown): void {
    if (this.failure) throw this.failure;
    if (!this.child || this.closed) throw new Error("Codex App Server is not connected");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex ${method} acknowledgement timed out; do not resend automatically`);
        this.fail(error);
        reject(error);
      }, this.options.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private receive(message: any): void {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new RequestRefused(`Codex request refused: ${String(message.error.message ?? "unknown error")}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      // Never silently grant an approval or invent a tool response.
      this.write({ id: message.id, error: { code: -32601, message: "Drovr headless runtime cannot handle this interactive request" } });
      return;
    }
    const p = message.params;
    this.options.onNotification?.(message.method, p);
    const active = this.active;
    if (!active || p?.threadId !== active.threadId) return;
    if (message.method === "turn/started") active.turnId ??= p.turn?.id;
    if (active.turnId && p.turnId && active.turnId !== p.turnId) return;
    if (message.method === "item/completed" && p.item?.type === "agentMessage") active.response = p.item.text;
    if (message.method === "turn/completed") {
      if (active.turnId && p.turn?.id !== active.turnId) return;
      this.active = undefined;
      if (p.turn?.status === "completed") active.resolve({ conversationId: active.threadId, response: active.response });
      else active.reject(new Error(`Codex turn ${p.turn?.status ?? "failed"}: ${p.turn?.error?.message ?? "no completed response"}`));
    }
  }

  async message(text: string, conversationId?: string): Promise<ManagedConversationResult> {
    return (await this.acceptMessage(text, conversationId)).completed;
  }

  /** Acknowledge receipt separately from completion so subsequent events can steer. */
  async acceptMessage(text: string, conversationId?: string): Promise<AcceptedCodexTurn> {
    if (this.options.instanceId) await (this.options.freezeStore ?? instanceFreezeStore).assertRunnable(this.options.instanceId);
    if (this.busy) throw new Error("Codex conversation is busy");
    if (!text.trim()) throw new Error("Codex message is empty");
    this.busy = true;
    try {
      await this.initialize();
      if (this.options.instanceId) await (this.options.freezeStore ?? instanceFreezeStore).assertRunnable(this.options.instanceId);
      if (this.threadId && conversationId && this.threadId !== conversationId) throw new Error("Codex conversation identity changed");
      if (!this.threadId) {
        const result = await this.request(conversationId ? "thread/resume" : "thread/start", {
          ...(conversationId ? { threadId: conversationId } : {}), cwd: this.options.cwd,
          // Keep review enabled without requiring an unattended UI to answer it.
          // A denial remains a denial; unsupported interactive requests fail closed.
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: this.options.permissionMode === "yolo" ? "danger-full-access" : this.options.permissionMode === "plan" ? "read-only" : "workspace-write",
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.options.config ? { config: this.options.config } : {}),
        });
        if (typeof result?.thread?.id !== "string" || (conversationId && result.thread.id !== conversationId)) throw new Error("Codex returned a different or missing conversation identity");
        this.threadId = result.thread.id;
      }
      const threadId = this.threadId!;
      let active!: ActiveTurn;
      const completed = new Promise<ManagedConversationResult>((resolve, reject) => { active = { threadId, response: "", resolve, reject }; });
      // A server exit can reject completion before turn/start has acknowledged.
      void completed.catch(() => {});
      this.active = active;
      try {
        if (this.options.instanceId) await (this.options.freezeStore ?? instanceFreezeStore).assertRunnable(this.options.instanceId);
        const result = await this.request("turn/start", { threadId, input: [{ type: "text", text }] });
        if (typeof result?.turn?.id !== "string") throw new Error("Codex returned no turn identity");
        if (active.turnId && active.turnId !== result.turn.id) throw new Error("Codex turn identity changed");
        active.turnId = result.turn.id;
        const tracked = completed.finally(() => { this.busy = false; });
        void tracked.catch(() => {});
        return { conversationId: threadId, completed: tracked };
      } catch (error) {
        if (this.active === active) this.active = undefined;
        throw error;
      }
    } catch (error) { this.busy = false; throw error; }
  }

  /** False means no input accepted (idle/startup race or explicit server refusal). */
  async steer(text: string): Promise<boolean> {
    if (this.options.instanceId) await (this.options.freezeStore ?? instanceFreezeStore).assertRunnable(this.options.instanceId);
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Codex App Server is closed");
    if (!text.trim()) throw new Error("Codex message is empty");
    const active = this.active;
    if (!active?.turnId) return false;
    try {
      const result = await this.request("turn/steer", {
        threadId: active.threadId, expectedTurnId: active.turnId,
        input: [{ type: "text", text }],
      });
      if (result?.turnId !== active.turnId) {
        const error = new Error("Codex steer returned a different turn identity; delivery uncertain");
        this.fail(error); throw error;
      }
      return true;
    } catch (error) {
      if (error instanceof RequestRefused) return false;
      throw error;
    }
  }

  /** Explicit host cancellation; never infer authority from channel message text. */
  async interrupt(): Promise<boolean> {
    if (this.failure) throw this.failure;
    const active = this.active;
    if (!active?.turnId) return false;
    try {
      await this.request("turn/interrupt", {threadId:active.threadId,turnId:active.turnId});
      return true;
    } catch (error) {
      if (error instanceof RequestRefused) return false;
      throw error;
    }
  }

  close(): Promise<void> {
    return this.closing ??= this.closeOnce();
  }

  private async closeOnce(): Promise<void> {
    this.freezeWatch?.close(); this.freezeWatch = undefined;
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("Codex App Server closed"));
    const child = this.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
}
