import type { ManagedAgentProvider } from "./agent-runtime.js";
import { ManagedConversationSession, type ConversationIdentity, type ConversationSessionOptions } from "./conversation-session.js";
import { ManagedConversationQuotaError, type ManagedConversationResult } from "./managed-conversation.js";
import { readNativeTranscript, NativeTranscriptUnavailableError } from "./native-transcript.js";
import { processProviderAvailability, runWithProviderFallback, type ProviderAvailabilityRegistry } from "./provider-fallback.js";

export interface ManagedConversationMessageOptions {
  /** Exclusive journal cutoff: the pending user event is not imported history. */
  beforeSequence?: number;
  reason?: string;
}

export interface ManagedConversationCommitContext {
  kind: "message" | "handoff";
  previous?: ConversationIdentity;
  reason: string;
  beforeSequence?: number;
}

export interface ManagedConversationLifecycleOptions {
  current?: ConversationIdentity;
  cwd: string;
  providers: readonly ManagedAgentProvider[];
  accountId: string;
  availability?: ProviderAvailabilityRegistry;
  createRunner: ConversationSessionOptions["createRunner"];
  /** Explicit journal fallback, used only when native history is absent. */
  readTranscript?: (beforeSequence?: number) => Promise<string>;
  /** Native disk reader injection for hosts and deterministic boundary tests. */
  readNativeTranscript?: typeof readNativeTranscript;
  commit: (identity: ConversationIdentity, context: ManagedConversationCommitContext) => Promise<void>;
}

/** Owns native identity, selection and every transition for a managed conversation. */
export class ManagedConversationLifecycle {
  private active: ConversationIdentity | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly providers: readonly ManagedAgentProvider[];

  constructor(private readonly options: ManagedConversationLifecycleOptions) {
    if (!options.accountId.trim()) throw new Error("Provider accountId must be nonempty");
    for (const provider of options.providers) this.validateProvider(provider);
    this.providers = [...options.providers];
    if (options.current) {
      this.validateIdentity(options.current);
      this.active = { ...options.current };
    }
  }

  get current(): ConversationIdentity | undefined { return this.active ? { ...this.active } : undefined; }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.catch(() => {}).then(operation);
    this.queue = pending;
    return pending;
  }

  private validateProvider(provider: ManagedAgentProvider): void {
    if (!["agy", "codex", "claude"].includes(provider)) throw new Error("Unsupported conversation provider");
  }

  private validateIdentity(identity: ConversationIdentity): void {
    this.validateProvider(identity.provider);
    if (!identity.conversationId || /^[\s-]|[\s\0]/.test(identity.conversationId)) throw new Error("Invalid conversation identity");
  }

  private async history(beforeSequence?: number): Promise<string> {
    if (this.active) {
      try {
        return await (this.options.readNativeTranscript ?? readNativeTranscript)({
          provider: this.active.provider, session: { kind: "id", value: this.active.conversationId }, cwd: this.options.cwd,
        });
      } catch (cause) {
        if (!(cause instanceof NativeTranscriptUnavailableError) || !this.options.readTranscript) throw cause;
      }
    }
    return this.options.readTranscript ? this.options.readTranscript(beforeSequence) : "[]";
  }

  private async commit(next: ConversationIdentity, context: ManagedConversationCommitContext): Promise<void> {
    this.validateIdentity(next);
    await this.options.commit({ ...next }, context);
    this.active = { ...next };
  }

  private async switchNow(provider: ManagedAgentProvider, reason: string, beforeSequence?: number): Promise<ConversationIdentity> {
    const previous = this.current;
    const session = new ManagedConversationSession({
      ...(previous ? { current: previous } : {}), cwd: this.options.cwd,
      createRunner: this.options.createRunner,
      readTranscript: () => this.history(beforeSequence),
      commit: next => this.commit(next, {
        kind: "handoff", reason, ...(previous ? { previous } : {}),
        ...(beforeSequence === undefined ? {} : { beforeSequence }),
      }),
    });
    return session.switchProvider(provider, reason);
  }

  switchProvider(provider: ManagedAgentProvider, reason = "Explicit provider switch"): Promise<ConversationIdentity> {
    return this.serialize(async () => {
      try { return await this.switchNow(provider, reason); }
      catch (cause) {
        if (cause instanceof ManagedConversationQuotaError && cause.provider === provider) {
          (this.options.availability ?? processProviderAvailability).markQuotaBlocked(
            { provider, accountId: this.options.accountId }, cause.refusal,
          );
        }
        throw cause;
      }
    });
  }

  message(text: string, options: ManagedConversationMessageOptions = {}): Promise<ManagedConversationResult> {
    const { beforeSequence, reason = "Provider fallback" } = options;
    return this.serialize(async () => {
      const priority = this.active ? [this.active.provider, ...this.providers] : this.providers;
      const outcome = await runWithProviderFallback({
        priority: priority.map(provider => ({ provider, accountId: this.options.accountId })),
        availability: this.options.availability ?? processProviderAvailability,
        attempt: async ({ provider }) => {
          let value: ManagedConversationResult;
          try {
            if (this.active && provider !== this.active.provider) await this.switchNow(provider, reason, beforeSequence);
            value = await this.options.createRunner(provider).message(text, this.active?.conversationId);
          } catch (cause) {
            if (cause instanceof ManagedConversationQuotaError && cause.provider === provider) {
              return { status: "quota-blocked" as const, refusal: cause.refusal };
            }
            throw cause;
          }
          const previous = this.current;
          if (previous && value.conversationId !== previous.conversationId) throw new Error("Native conversation changed identity while resuming");
          await this.commit({ provider, conversationId: value.conversationId }, {
            kind: "message", reason, ...(previous ? { previous } : {}),
            ...(beforeSequence === undefined ? {} : { beforeSequence }),
          });
          return { status: "success" as const, value };
        },
      });
      if (outcome.status === "exhausted") throw new Error("Managed conversation providers exhausted; current conversation retained");
      return outcome.value;
    });
  }
}
