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
- `observePane(account, status, text)` accepts ANSI-stripped live pane text,
  applies the idle/done gate, runs the account's provider classifier
  (`classifyProviderQuotaText`), returns its full outcome, and records only a
  recognised refusal. Claude and Codex have classifiers; AGY has none and is
  never recorded from a pane. `observeClaudePane` is the Claude-only form.

`selectAvailableProvider` and `runWithProviderFallback` always walk the
caller's priority from the top, skipping blocked accounts. So when the current
worker's provider becomes quota-blocked, its replacement is the first
available provider in the whole list — a Codex worker at its limit goes back
to Claude under `claude,codex`, and a Claude worker at its limit goes to
Codex. A blocked account with a known reset is eligible again, at its own
position, from `now >= resetsAt`.

### Codex usage limits

`classifyCodexUsageLimitText(text, now)` recognises two notices, both string
constants in the Codex CLI binary (0.155.0-alpha.16.4), at column 0 only:

- `• Automatically switched to <model> due to usage limits.` Observed live on
  2026-09-24 on idle panes, either followed by the server's "Add credits …
  or wait for usage to reset after 16:03 on 29 Sep." dialog or directly by
  the `›` composer. Codex keeps running on the fallback model, which is why an
  idle pane looks healthy to Herdr and was never replaced.
- `■ You’ve hit your usage limit…`, the TUI error cell for a refused turn.

Only the most recent notice counts. `Automatically switched back to <model>
because ordinary usage is available again.` after it means not refused. Any
later column-0 history cell (a `•` message, `■` error, `─ Worked for`) means
the agent carried on, and the notice is `suppressed` with the reason. Only
blank, indented, and `›` lines may follow a live notice. The reset is parsed
from the notice's own block, in host local time: `reset after HH:MM on D Mon
[YYYY]` (the nearest such date; a passed date stays passed), or the error's
`try again at H:MM AM|PM` (next occurrence) and dated `Mon D[th][, YYYY] [at]
H:MM AM|PM`. Otherwise `resetsAt` is null and the account stays blocked until
`clear(account)` or a later observation with a known reset. Like the Claude
classifier, an agent message whose first line is byte-for-byte the notice is
indistinguishable from it; the idle/done gate still applies.
`codexTurnErrorQuota(error, now)` is the equivalent for a failed turn's error
(exec JSONL or App Server).

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
