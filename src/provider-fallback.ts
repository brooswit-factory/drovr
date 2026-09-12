import type { ManagedAgentProvider } from "./agent-runtime.js";
import { classifySessionLimitText, type SessionLimitOutcome } from "./session-limit.js";

/** Stable credential/account identity, shared across panes, workspaces and models. */
export interface ProviderAccount {
  provider: ManagedAgentProvider;
  accountId: string;
}

export interface ProviderQuotaRefusal {
  /** Epoch milliseconds, or null when the provider did not report a usable reset. */
  resetsAt: number | null;
  raw: string;
}

export type ProviderAvailability =
  | { status: "available" }
  | { status: "quota-blocked"; resetsAt: number | null; raw: string };

function accountKey(account: ProviderAccount): string {
  if (!account.accountId.trim()) throw new Error("Provider accountId must be nonempty");
  return JSON.stringify([account.provider, account.accountId]);
}

/** In-memory shared account state. Unknown resets require explicit clear(). */
export class ProviderAvailabilityRegistry {
  private readonly blocked = new Map<string, ProviderQuotaRefusal>();

  constructor(private readonly now: () => number = Date.now) {}

  get(account: ProviderAccount): ProviderAvailability {
    const key = accountKey(account);
    const refusal = this.blocked.get(key);
    if (!refusal) return { status: "available" };
    if (refusal.resetsAt !== null && this.now() >= refusal.resetsAt) {
      this.blocked.delete(key);
      return { status: "available" };
    }
    return { status: "quota-blocked", ...refusal };
  }

  /** Accept only a confirmed provider quota refusal, never a generic error. */
  markQuotaBlocked(account: ProviderAccount, refusal: ProviderQuotaRefusal): void {
    if (refusal.resetsAt !== null && !Number.isFinite(refusal.resetsAt)) {
      throw new Error("Quota reset must be a finite epoch timestamp or null");
    }
    const key = accountKey(account);
    const existing = this.blocked.get(key);
    // Delayed observations from another pane must not shorten a known block.
    if (existing?.resetsAt != null && this.now() < existing.resetsAt
      && (refusal.resetsAt === null || refusal.resetsAt <= existing.resetsAt)) return;
    this.blocked.set(key, { resetsAt: refusal.resetsAt, raw: refusal.raw });
  }

  /** Operator reset or independently confirmed account recovery. */
  clear(account: ProviderAccount): void {
    this.blocked.delete(accountKey(account));
  }

  /** ANSI-stripped live pane text only; active/unknown states cannot establish quota. */
  observeClaudePane(account: ProviderAccount, status: string, text: string): SessionLimitOutcome {
    if (account.provider !== "claude" || (status !== "idle" && status !== "done")) {
      return { kind: "not-recognised" };
    }
    const outcome = classifySessionLimitText(text, new Date(this.now()));
    if (outcome.kind === "recognised") this.markQuotaBlocked(account, outcome);
    return outcome;
  }
}

export type ProviderSelection =
  | { status: "selected"; account: ProviderAccount }
  | { status: "exhausted" };

/** Shared by default across all consumers of this module in one process. */
export const processProviderAvailability = new ProviderAvailabilityRegistry();

/** The caller's array defines priority. This does not reserve an account. */
export function selectAvailableProvider(
  priority: readonly ProviderAccount[],
  availability: ProviderAvailabilityRegistry = processProviderAvailability,
): ProviderSelection {
  for (const account of priority) {
    if (availability.get(account).status === "available") return { status: "selected", account };
  }
  return { status: "exhausted" };
}

export type ProviderAttemptResult<T> =
  | { status: "success"; value: T }
  | { status: "quota-blocked"; refusal: ProviderQuotaRefusal };

export type ProviderFallbackResult<T> =
  | { status: "success"; account: ProviderAccount; value: T; attempted: ProviderAccount[] }
  | { status: "exhausted"; reason: "no-available-provider" | "attempt-limit"; attempted: ProviderAccount[] };

/**
 * Each distinct account is attempted at most once, in priority order. Exceptions
 * propagate unchanged. The caller owns attempt cleanup before reporting quota;
 * this function neither closes panes nor retries arbitrary provider failures.
 */
export async function runWithProviderFallback<T>(options: {
  priority: readonly ProviderAccount[];
  availability?: ProviderAvailabilityRegistry;
  maxAttempts?: number;
  attempt: (account: ProviderAccount) => Promise<ProviderAttemptResult<T>>;
}): Promise<ProviderFallbackResult<T>> {
  const availability = options.availability ?? processProviderAvailability;
  const candidates = new Map<string, ProviderAccount>();
  for (const account of options.priority) {
    const key = accountKey(account);
    if (!candidates.has(key)) candidates.set(key, { ...account });
  }
  const maxAttempts = options.maxAttempts ?? candidates.size;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
    throw new Error("maxAttempts must be a nonnegative safe integer");
  }
  const attempted: ProviderAccount[] = [];
  for (const account of candidates.values()) {
    if (availability.get(account).status !== "available") continue;
    if (attempted.length >= maxAttempts) return { status: "exhausted", reason: "attempt-limit", attempted };
    attempted.push({ ...account });
    const result = await options.attempt({ ...account });
    if (result.status === "success") return { status: "success", account, value: result.value, attempted };
    if (result.status !== "quota-blocked") throw new Error("Unsupported provider attempt result");
    availability.markQuotaBlocked(account, result.refusal);
  }
  return { status: "exhausted", reason: "no-available-provider", attempted };
}
