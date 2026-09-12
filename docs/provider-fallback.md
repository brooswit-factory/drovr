# Provider quota fallback

Drovr exports `processProviderAvailability`, a shared in-memory
`ProviderAvailabilityRegistry`. All HerdrHerd instances in the same process
should use this singleton (the default for selection and fallback), or receive
the same explicitly constructed registry. State is not persisted across process
restarts and does not coordinate separate processes or duplicate module copies.

An account is `{ provider: ManagedAgentProvider, accountId: string }`. Use a stable,
non-secret credential identity shared across panes, models, and workspaces.

- `get(account)` returns `available` or `quota-blocked` with `resetsAt` and `raw`.
- `markQuotaBlocked(account, { resetsAt, raw })` accepts a confirmed refusal.
  Known resets are epoch milliseconds and expire at `now >= resetsAt`. While a
  known block is live, older reset reports and unknown reports cannot shorten
  or erase it; later resets extend it. Unknown blocks can acquire a known reset.
- A null reset remains blocked indefinitely until `clear(account)` or a known
  reset is reported. Clear only on operator action or independently confirmed
  recovery. Ordinary healthy pane text does not establish account recovery.
- `observeClaudePane(account, status, text)` accepts ANSI-stripped live pane
  text, applies the idle/done gate, returns the classifier's full outcome, and
  records only recognised Claude refusals. There is no Codex or AGY classifier.

`selectAvailableProvider(priority, availability?)` selects the first available
account or returns `{ status: "exhausted" }`. The array defines the order.

`runWithProviderFallback({ priority, availability?, maxAttempts?, attempt })`
invokes `attempt(account)` once per distinct available account, in order, bounded
by `maxAttempts` (default: unique account count). The callback returns either
`{ status: "success", value }` or
`{ status: "quota-blocked", refusal: { resetsAt, raw } }`. Only the latter
advances fallback. Exceptions propagate unchanged; HTTP errors, timeouts,
authentication errors, and arbitrary output never imply quota.

Results are `{ status: "success", account, value, attempted }` or
`{ status: "exhausted", reason, attempted }`, with reason `attempt-limit` or
`no-available-provider`. Empty and fully blocked lists explicitly exhaust.
Selection does not reserve accounts, and separate simultaneous invocations can
attempt the same account before either reports quota. The attempt bound is per
invocation, not a timeout; callers own cancellation and provider timeouts.

Butchr owns pane cleanup and task recovery. It can implement `recoverQuota(spec)`
by recording the confirmed refusal, cleaning up the refused attempt, then
calling `runWithProviderFallback`. Finish cleanup before reporting quota from
an attempt callback. Reuse the same registry for launch and midtask recovery.

The dependency-free Claude classifier and its regression fixtures were copied
from Butchr `src/agents/session-limit.ts` and `test/unit/session-limit.test.ts`.
`classifySessionLimitText(text, now)` and `detectSessionLimitRefusal(text, now)`
are exported unchanged. All pairing, margin, tail, and suppression guards remain.
Its documented limitation remains: byte-identical tool output can be
indistinguishable from a live banner. Its printed clock parser uses host local
time, as in Butchr; pane timezone must match. Do not repeatedly reclassify a stale
capture after reset: the next-occurrence clock parser can interpret it as
tomorrow. Callers must supply fresh observations from the current attempt.
