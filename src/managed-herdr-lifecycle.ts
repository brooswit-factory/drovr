import { randomUUID } from "node:crypto";
import type { results } from "@brooswit/herdr-sdk";
import { buildAgentStartParams, mergeDevelopmentChannels, type ManagedAgentLaunch, type ManagedAgentProvider } from "./agent-runtime.js";
import { startManagedAgent, type AgentStartOptions } from "./agent-start.js";
import { HANDOFF_ACK, ManagedConversationSession } from "./conversation-session.js";
import type { DrovrClient } from "./drovr-client.js";
import { nativeTranscriptReply, readNativeTranscript, type NativeTranscriptOptions } from "./native-transcript.js";
import { processProviderAvailability, runWithProviderFallback, type ProviderAccount, type ProviderAvailabilityRegistry, type ProviderFallbackResult } from "./provider-fallback.js";

export interface ManagedHerdrIdentity {
  paneId: string;
  provider: ManagedAgentProvider;
  cwd: string;
  home?: string;
}

export interface ManagedHerdrLifecycleOptions {
  client: DrovrClient;
  cwd: string;
  current?: ManagedHerdrIdentity;
  availability?: ProviderAvailabilityRegistry;
  startOptions?: AgentStartOptions;
  wait?: (ms: number) => Promise<void>;
  acknowledgementTimeoutMs?: number;
  pollIntervalMs?: number;
  kickoffVerifyMs?: number;
  /** Native history reader injection; never supply terminal-screen text. */
  readTranscript?: (options: NativeTranscriptOptions) => Promise<string>;
}

export interface ManagedHerdrStartRequest {
  priority: readonly ProviderAccount[];
  label: string;
  /** Required to replace an existing worker; stale handles fail closed. */
  replacePaneId?: string;
  reason?: string;
  prepare: (provider: ManagedAgentProvider) => Promise<{
    /** Drovr overrides prompt and paneId for the transaction. */
    launch: ManagedAgentLaunch;
    env?: Record<string, string>;
    home?: string;
  }>;
  kickoff: (provider: ManagedAgentProvider) => string;
  /**
   * Provider-neutral MCP configuration file path. Supplied once per request and
   * applied to whichever provider wins selection; overrides the prepared launch.
   */
  mcpConfigPath?: string;
  /**
   * Provider-neutral development channel names. These are merged with whatever
   * the prepared launch already configures, so a request adds its channels
   * without dropping the launch's own. An empty list adds nothing.
   */
  developmentChannels?: readonly string[];
  /**
   * MCP servers whose notifications must reach the worker. Merged the same way;
   * Drovr, not the caller, knows how a provider names the resulting channel.
   */
  mcpNotificationServers?: readonly string[];
}

export type ManagedHerdrResult = ProviderFallbackResult<string> | {
  status: "blocked";
  reason: string;
  current: ManagedHerdrIdentity | undefined;
};

class HandoffBlocked extends Error {}

/**
 * Apply the request's provider-neutral launch inputs to whatever the caller
 * prepared. Drovr owns the translation to provider flags, so callers never
 * spell a provider's CLI. One MCP configuration path replaces another because
 * a launch reads exactly one file; development channels merge, because a
 * request naming one channel must not silently drop a launch's others.
 */
function applyNeutralLaunchInputs(launch: ManagedAgentLaunch, request: ManagedHerdrStartRequest): ManagedAgentLaunch {
  const developmentChannels = mergeDevelopmentChannels(launch.developmentChannels, request.developmentChannels);
  const mcpNotificationServers = mergeDevelopmentChannels(launch.mcpNotificationServers, request.mcpNotificationServers);
  return {
    ...launch,
    ...(request.mcpConfigPath === undefined ? {} : { mcpConfigPath: request.mcpConfigPath }),
    ...(developmentChannels.length ? { developmentChannels } : {}),
    ...(mcpNotificationServers.length ? { mcpNotificationServers } : {}),
  };
}

const clientQueues = new WeakMap<DrovrClient, Map<string, Promise<unknown>>>();

/** One instance per logical workspace. All mutations route to exact pane IDs. */
export class ManagedHerdrLifecycle {
  private active: ManagedHerdrIdentity | undefined;
  private readonly nativeSessions = new Map<string, string>();
  private readonly wait: (ms: number) => Promise<void>;
  private readonly availability: ProviderAvailabilityRegistry;

  constructor(private readonly options: ManagedHerdrLifecycleOptions) {
    if (options.current && options.current.cwd !== options.cwd) throw new Error("Current worker belongs to another workspace");
    this.active = options.current ? { ...options.current } : undefined;
    this.wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.availability = options.availability ?? processProviderAvailability;
    for (const value of [options.acknowledgementTimeoutMs ?? 120_000, options.pollIntervalMs ?? 500]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error("Lifecycle deadlines must be positive and finite");
    }
  }

  get current(): ManagedHerdrIdentity | undefined { return this.active ? { ...this.active } : undefined; }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    let queues = clientQueues.get(this.options.client);
    if (!queues) { queues = new Map(); clientQueues.set(this.options.client, queues); }
    const pending = (queues.get(this.options.cwd) ?? Promise.resolve()).catch(() => {}).then(action);
    queues.set(this.options.cwd, pending);
    void pending.finally(() => {
      if (queues.get(this.options.cwd) === pending) queues.delete(this.options.cwd);
    }).catch(() => {});
    return pending;
  }

  /** An established identity never falls back to another pane at the same cwd. */
  async resolveCurrent(): Promise<results.AgentInfo | undefined> {
    const { agents } = await this.options.client.agent.list();
    if (this.active) return agents.find(a => a.pane_id === this.active!.paneId && a.cwd === this.active!.cwd && a.agent === this.active!.provider);
    const matches = agents.filter(a => a.cwd === this.options.cwd);
    if (matches.length > 1) throw new HandoffBlocked("Multiple workers at workspace; explicit current identity required");
    const found = matches[0];
    if (found) {
      if (!found.agent || !["claude", "codex", "agy"].includes(found.agent)) throw new HandoffBlocked("Unsupported current provider");
      this.active = { paneId: found.pane_id, provider: found.agent as ManagedAgentProvider, cwd: this.options.cwd };
    }
    return found;
  }

  prompt(text: string): Promise<results.AgentInfo | undefined> {
    return this.exclusive(async () => {
      const current = await this.resolveCurrent();
      if (!current) return undefined;
      return (await this.options.client.agent.prompt({ target: current.pane_id, text })).agent;
    });
  }

  stop(): Promise<void> {
    return this.exclusive(async () => {
      const current = await this.resolveCurrent();
      if (current) await this.options.client.pane.close(current.pane_id);
      this.active = undefined;
      this.nativeSessions.clear();
    });
  }

  start(request: ManagedHerdrStartRequest): Promise<ManagedHerdrResult> {
    return this.exclusive(async () => {
      try {
        const existing = await this.resolveCurrent();
        if (request.replacePaneId && existing?.pane_id !== request.replacePaneId) throw new HandoffBlocked("Replacement worker changed or disappeared");
        if (existing && !request.replacePaneId) return { status: "success", value: existing.pane_id, account: { provider: this.active!.provider, accountId: "default" }, attempted: [] };
        if (!existing && this.active) throw new HandoffBlocked("Current worker disappeared; refusing implicit replacement");
        return await runWithProviderFallback({
          priority: request.priority,
          availability: this.availability,
          attempt: async account => {
            const old = this.current;
            // Read before preparation, pane creation, or launch. Never import a screen snapshot.
            let transcript: string | undefined;
            if (old) {
              await this.assertStable(old);
              try {
                transcript = await this.nativeTranscript(old);
                if (!transcript.trim() || transcript.trim() === "[]") throw new Error("Saved transcript is empty");
              } catch (error) { throw new HandoffBlocked(`Cannot read current native transcript: ${String(error)}`); }
            }
            const prepared = await request.prepare(account.provider);
            if (prepared.launch.provider !== account.provider || prepared.launch.cwd !== this.options.cwd) throw new Error("Launch does not match selected provider and workspace");
            const launch = applyNeutralLaunchInputs(prepared.launch, request);
            const created = await this.options.client.workspace.create({ label: request.label, cwd: this.options.cwd, ...(prepared.env ? { env: prepared.env } : {}) });
            const root = created.root_pane;
            const paneId = typeof root === "string" ? root : root?.pane_id;
            if (!paneId || paneId === old?.paneId) throw new HandoffBlocked("Workspace did not return a distinct target pane");
            const target: ManagedHerdrIdentity = { paneId, provider: account.provider, cwd: this.options.cwd, ...(prepared.home ? { home: prepared.home } : {}) };
            let committed = false;
            try {
              if (old) {
                const session = new ManagedConversationSession({
                  cwd: this.options.cwd,
                  readTranscript: async () => transcript!,
                  createRunner: () => ({ message: async (prompt, conversationId) => {
                    const token = `${HANDOFF_ACK}_${randomUUID()}`;
                    const importPrompt = prompt.replaceAll(HANDOFF_ACK, token);
                    if (conversationId) {
                      if (conversationId !== paneId) throw new HandoffBlocked("Import target changed");
                      await this.options.client.agent.prompt({ target: paneId, text: importPrompt });
                    } else {
                      // Herdr 0.8.2 rejects literal newlines in launch argv.
                      // Transcript data is already JSON-escaped by the session;
                      // only the surrounding instruction separators change.
                      await startManagedAgent(this.options.client, buildAgentStartParams({ ...launch, paneId, prompt: importPrompt.replaceAll("\n", " ") }), this.options.startOptions);
                    }
                    const response = await this.awaitAcknowledgement(target, token);
                    return { conversationId: paneId, response: response.replace(token, HANDOFF_ACK) };
                  } }),
                  commit: async () => {
                    await this.assertStable(old);
                    await this.assertStable(target);
                    if (await this.nativeTranscript(old) !== transcript) throw new HandoffBlocked("Source history changed during import; retry with a fresh snapshot");
                    this.active = target;
                    committed = true;
                  },
                });
                await session.switchProvider(account.provider, request.reason ?? `Replace ${old.provider} worker with imported history`);
                // Retirement failure leaves the acknowledged target current, but dispatches no work.
                await this.options.client.pane.close(old.paneId);
                await this.options.client.agent.prompt({ target: paneId, text: request.kickoff(account.provider) });
              } else {
                await startManagedAgent(this.options.client, buildAgentStartParams({ ...launch, paneId, prompt: request.kickoff(account.provider) }), this.options.startOptions);
                this.active = target;
                committed = true;
              }
            } catch (error) {
              if (!committed) await this.options.client.pane.close(paneId).catch(() => {});
              if (old) throw new HandoffBlocked(`Provider handoff stopped: ${String(error)}`);
              throw error;
            }
            await this.wait(this.options.kickoffVerifyMs ?? 12_000);
            const current = await this.resolveCurrent();
            if (!current) throw new HandoffBlocked("Current worker disappeared before kickoff verification");
            if (current && (current.agent_status === "idle" || current.agent_status === "done")) {
              // Each provider with a measured classifier (Claude, Codex) can
              // refuse at kickoff; a recognised refusal moves on to the next
              // provider in priority order.
              if (account.provider === "claude" || account.provider === "codex") {
                const screen = await this.options.client.pane.read({ pane_id: paneId, source: "detection", strip_ansi: true });
                const outcome = this.availability.observePane(account, current.agent_status, screen.read.text);
                if (outcome.kind === "recognised") return { status: "quota-blocked", refusal: { resetsAt: outcome.resetsAt, raw: outcome.raw } };
              }
              // Idle/done can mean the task finished quickly. It is not proof
              // that kickoff was swallowed, so never automatically repeat it.
            }
            return { status: "success", value: paneId };
          },
        });
      } catch (error) {
        if (error instanceof HandoffBlocked) return { status: "blocked", reason: error.message, current: this.current };
        throw error;
      }
    });
  }

  private async assertStable(expected: ManagedHerdrIdentity): Promise<void> {
    const { agents } = await this.options.client.agent.list();
    const old = agents.find(a => a.pane_id === expected.paneId && a.cwd === expected.cwd && a.agent === expected.provider);
    if (!old || (old.agent_status !== "idle" && old.agent_status !== "done")) throw new HandoffBlocked("Previous worker changed or is not idle");
  }

  private async nativeTranscript(identity: ManagedHerdrIdentity): Promise<string> {
    const { agent } = await this.options.client.agent.get(identity.paneId);
    if (agent.pane_id !== identity.paneId || agent.cwd !== identity.cwd || agent.agent !== identity.provider) throw new Error("Native transcript worker identity changed");
    const session = agent?.agent_session;
    if (!session || session.agent !== identity.provider) throw new Error("Exact pane has no matching native session reference");
    const reference = JSON.stringify([session.agent, session.kind, session.value]);
    const pinned = this.nativeSessions.get(identity.paneId);
    if (pinned && pinned !== reference) throw new Error("Native session reference changed during lifecycle");
    this.nativeSessions.set(identity.paneId, reference);
    return (this.options.readTranscript ?? readNativeTranscript)({ provider: identity.provider, session: { kind: session.kind, value: session.value }, cwd: identity.cwd, ...(identity.home ? { home: identity.home } : {}) });
  }

  private async awaitAcknowledgement(target: ManagedHerdrIdentity, token: string): Promise<string> {
    const interval = this.options.pollIntervalMs ?? 500;
    const timeout = this.options.acknowledgementTimeoutMs ?? 120_000;
    const deadline = performance.now() + timeout;
    // A bounded count also keeps fake clocks and instantaneous test waits finite.
    for (let elapsed = 0; elapsed <= timeout; elapsed += interval) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        const last = await Promise.race([
          (async () => {
            const reply = nativeTranscriptReply(target.provider, await this.nativeTranscript(target))?.trim();
            if (!reply?.startsWith(token + "\n") || !reply.slice(token.length).trim()) return undefined;
            // Native output can be flushed before Herdr observes turn completion.
            await this.assertStable(target);
            return reply;
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HandoffBlocked("Native acknowledgement read timed out")), remaining); }),
        ]);
        if (last) return last;
      } catch { /* Session discovery and atomic native writes may lag startup. */ }
      finally { if (timer !== undefined) clearTimeout(timer); }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      if (elapsed < timeout) await this.wait(Math.min(interval, timeout - elapsed, remaining));
    }
    throw new HandoffBlocked("Target did not acknowledge an imported working summary before the deadline");
  }
}
