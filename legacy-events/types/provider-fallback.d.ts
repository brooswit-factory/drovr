import type { ManagedAgentProvider } from "./agent-runtime.js";
import { type SessionLimitOutcome } from "./session-limit.js";
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
export type ProviderAvailability = {
    status: "available";
} | {
    status: "quota-blocked";
    resetsAt: number | null;
    raw: string;
};
/** In-memory shared account state. Unknown resets require explicit clear(). */
export declare class ProviderAvailabilityRegistry {
    private readonly now;
    private readonly blocked;
    constructor(now?: () => number);
    get(account: ProviderAccount): ProviderAvailability;
    /** Accept only a confirmed provider quota refusal, never a generic error. */
    markQuotaBlocked(account: ProviderAccount, refusal: ProviderQuotaRefusal): void;
    /** Operator reset or independently confirmed account recovery. */
    clear(account: ProviderAccount): void;
    /** ANSI-stripped live pane text only; active/unknown states cannot establish quota. */
    observeClaudePane(account: ProviderAccount, status: string, text: string): SessionLimitOutcome;
}
export type ProviderSelection = {
    status: "selected";
    account: ProviderAccount;
} | {
    status: "exhausted";
};
/** Shared by default across all consumers of this module in one process. */
export declare const processProviderAvailability: ProviderAvailabilityRegistry;
/** The caller's array defines priority. This does not reserve an account. */
export declare function selectAvailableProvider(priority: readonly ProviderAccount[], availability?: ProviderAvailabilityRegistry): ProviderSelection;
export type ProviderAttemptResult<T> = {
    status: "success";
    value: T;
} | {
    status: "quota-blocked";
    refusal: ProviderQuotaRefusal;
};
export type ProviderFallbackResult<T> = {
    status: "success";
    account: ProviderAccount;
    value: T;
    attempted: ProviderAccount[];
} | {
    status: "exhausted";
    reason: "no-available-provider" | "attempt-limit";
    attempted: ProviderAccount[];
};
/**
 * Each distinct account is attempted at most once, in priority order. Exceptions
 * propagate unchanged. The caller owns attempt cleanup before reporting quota;
 * this function neither closes panes nor retries arbitrary provider failures.
 */
export declare function runWithProviderFallback<T>(options: {
    priority: readonly ProviderAccount[];
    availability?: ProviderAvailabilityRegistry;
    maxAttempts?: number;
    attempt: (account: ProviderAccount) => Promise<ProviderAttemptResult<T>>;
}): Promise<ProviderFallbackResult<T>>;
