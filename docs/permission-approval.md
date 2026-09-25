# Approving a pending permission prompt

A session in a default or ask permission mode stops on Claude's tool
permission dialog and waits for someone at its terminal. These functions let
an operator, or a host acting for one (bakr, usrr), approve that prompt from
anywhere. Drovr is a library, so the command itself belongs to the host.

```ts
const pending = await listPendingPermissions(client);
// [{ paneId: "w1:p1", label, sessionId, cwd, tool: "Bash command",
//    request: "touch x.txt\nCreate empty file", promptId: "20d2c5b2f8308147", options, cursor }]

const result = await approvePermission(client, {
  paneId: "w1:p1",
  promptId: "20d2c5b2f8308147",   // the prompt the operator saw
  operator: "brooswit",
  scope: "once",                  // default; "always" must be asked for
  auditPath: `${homedir()}/.local/state/bakr/permission-approvals.jsonl`,
});
// { ok: true, attemptId, tool, request, scope }
// { ok: false, attemptId, reason, detail }
```

## What it answers, and what it cannot

Measured on claude 2.1.277 in a herdr pane:

```
─────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — …

   touch drovr-permission-probe.txt
   Create empty probe file

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/… from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
```

Only this dialog is recognised: a "Do you want to …?" question under a
separator, numbered options that start with "Yes" and include a "No", and the
"Esc to cancel" footer. Trust, development-channels and MCP-approval prompts
belong to `hostResident`.

An **auto-mode classifier denial** is not a prompt. The tool call is refused
outright and nothing waits on screen, so nothing here can approve it. Only a
permission rule that the session reads at start changes that outcome.

## Guarantees

- **Only the prompt the operator saw.** The screen is re-read before any key
  is sent. If it now shows a different prompt (`promptId` hashes the tool,
  request, question and options, not the cursor), the call is refused as
  `prompt-changed` and nothing is pressed.
- **Never auto mode.** `once` answers "Yes". `always` answers the "Yes, and …"
  option that stores a rule, which Claude words "always allow … from this
  project", so it outlives the session. The option that switches the session
  to auto mode is never chosen.
- **Audit first.** A JSONL record (`outcome: "approving"`) is written before
  any key is sent. If it cannot be written the call is `audit-failed` and
  nothing is pressed. A second record carries the outcome. Refusals are
  recorded too. Records hold `ts, attemptId, operator, paneId, label,
  sessionId, promptId, scope, tool, request` (truncated to 500 characters),
  `option` and `outcome`, and the file is created mode 0600.
- **Verified.** Success means the prompt left the screen. Keys that leave it
  there are `not-cleared`, never claimed as approved.

Every Claude pane's screen is read, not only those herdr marks `blocked`,
because a dialog herdr misreports as idle is exactly what Drovr is for.
Sessions on `claude --bg` are not covered yet: they can only be reached
through `claude attach`.

## Proof

`scripts/probe-permission-prompt.ts` starts claude in default mode in a named
`drovr-proof-*` herdr session and leaves it on a real Bash prompt.
`scripts/verify-permission-approve.ts` then lists it, refuses a stale
`promptId`, approves the real one once, and checks that the command ran.
Both passed on 2026-09-18.

## Unattended: `autoAnswerPermissions`

```ts
const results = await autoAnswerPermissions(client, {
  auditPath: `${homedir()}/.local/state/bakr/permission-approvals.jsonl`,
  operator: "drovr-auto",  // default; pass one only to override it
  readTimeoutMs: 10_000,   // optional per-pane deadline
});
// [{ paneId: "w1:p1", label, outcome: "answered", tool, request }
//  { paneId: "w2:p1", label, outcome: "skipped", reason }
//  { paneId: "w3:p1", label, outcome: "failed", reason, detail }]
```

One unattended pass over every pane `listPendingPermissions` reports, with no
operator in the loop: every prompt is answered with the `scope: "always"`
option, which is option 2 in the dialog measured above, and nothing else.

- **Option rule.** Before `approvePermission` is ever called, the prompt's own
  `options` are checked: only when the "Yes, and …" stored-rule option (never
  the auto-mode one) sits at position 2 does the pane get an approve attempt.
  A prompt where it sits elsewhere, or is absent, is `skipped` with a reason
  naming what was actually at that position — no key is pressed and no
  `approving` audit record is written for it, because the check runs before
  the call that would write one.
- **Audited as `drovr-auto`.** The default `operator`, distinct from a human
  name, so an unattended answer is never mistaken for one a person gave.
  Every other `approvePermission` guarantee still applies: audit before keys,
  re-read and refuse a changed prompt, success only once the prompt clears.
- **One pane never stops the rest.** Each pending prompt gets its own
  independent attempt; one throwing, or (when `readTimeoutMs` is given)
  taking longer than the deadline, becomes a `failed` result for that pane
  alone; every other pane's result is unaffected.
- **`readTimeoutMs` bounds the whole approve attempt, not a single read, and
  does not cancel it.** It's a deadline on the entire `approvePermission`
  call for one pane — the re-read, the keys, and the wait for the prompt to
  clear — not on any one `read()`. A pane past it gets `outcome: "failed",
  reason: "timeout"`, but `approvePermission` is not cancelled: it keeps
  running in the background and may still press keys and write `approved` to
  the audit log afterwards, or a deadline shorter than the verify window can
  fire while a real answer is still landing. **A `timeout` result means the
  outcome is unknown, not "nothing pressed"** — check the audit log for that
  pane before treating it as untouched.
- **Result mapping.** `ok: true` is `answered`. Of `approvePermission`'s
  refusal reasons, `prompt-changed`, `no-prompt` and `option-missing` map to
  `skipped` (the operator-visible reason is `approvePermission`'s own
  `detail`) because nothing was pressed and the pane may simply need a fresh
  scan; `invalid-operator`, `audit-failed` and `not-cleared` map to `failed`,
  because those name a problem with the attempt itself, not a stale read. A
  pane that throws, or that misses its `readTimeoutMs` deadline, is also
  `failed`.

**Left to their own tickets, deliberately not fixed here:**

- **DROVR-24** (a throwing `sendKeys` leaves an `approving` audit record with
  no outcome) is not fixed inside `approvePermission` itself — that record
  still stands incomplete on disk after a throw. `autoAnswerPermissions` only
  guarantees that such a throw becomes a `failed` result for that pane
  instead of rejecting the whole pass; the audit trail's own gap is
  unchanged.
- **DROVR-33** (an unreadable pane reads as "no prompt", and
  `listPendingPermissions`'s own scan has no per-read deadline) is unchanged
  in `listPendingPermissions`, which `autoAnswerPermissions` calls as its scan
  step: a pane that fails to read during the scan is silently absent from the
  results, not reported as `failed`. `readTimeoutMs` only bounds the
  **approve** attempt for a pane the scan already found; it does not bound
  the scan itself.

## A wrapped option used to be invisible, not just unanswered

Found live during DROVR-41's proof (claude 2.1.251, 2026-09-25): a real
Bash-tool dialog whose option 2 was long enough to wrap onto a second
physical line with no number of its own —

```
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for mkdir -p scratch-dir-neg and rm -rf scratch-dir-neg
      commands in /tmp/drovr-herdr-proof.41-neg
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend · ctrl+e to explain
```

— was not `skipped`, it was invisible: `classifyPermissionPrompt` returned
`undefined` for the whole screen, because the option-collecting loop broke on
the wrapped continuation line ("      commands in /tmp/…") and the footer
check then looked at the wrong window. `listPendingPermissions` never
surfaced the pane, so `autoAnswerPermissions` never saw it — worse than
"skipped", because an agent sitting on it would sit frozen exactly like the
case DROVR-37 exists to fix. Fixed: a non-option line now folds into the
option it continues unless it's blank, the "Esc to cancel" footer, or a fresh
separator/question, any of which still ends the scan. Covered by regression
tests built from this exact raw screen in `test/permission-approval.test.ts`.

## Live proof (DROVR-41, 2026-09-25)

`scripts/verify-auto-answer-permissions.ts` is the opt-in proof: it opens two
real Claude panes in default permission mode inside a named `drovr-proof-*`
herdr session (never a default socket), provokes a real dialog in each, runs
one `autoAnswerPermissions` pass over both, and checks the result. Measured
on claude 2.1.251:

- **Positive** — a Bash-tool dialog ("touch drovr-permission-probe.txt")
  whose option 2 is "Yes, and always allow access to …/pos from this
  project": the pass returned `outcome: "answered"` for that pane, option 2
  is what was pressed, the audit JSONL holds `approving` then `approved`
  under `operator: "drovr-auto"`, the probe file appeared, and a follow-up
  scan no longer lists the pane.
- **Negative** — a Read-tool dialog outside the project ("Read(/etc/hostname)")
  whose options are `["Yes", "Yes, allow reading from /etc during this
  session", "No"]`, no "Yes, and …" match: the same pass returned `outcome:
  "skipped"` with a reason naming what was actually at option 2, pressed
  nothing, and wrote no audit record for that pane at all.
- The run is what surfaced the wrapped-option bug above; re-run live against
  the same wrapped dialog after the fix, `autoAnswerPermissions` answered it
  correctly on the next pass.

Full log/audit excerpts are in the DROVR-41 PR description and ticket.

## Host wiring

Drovr is a library — it never runs anything on a timer itself; "the command
itself belongs to the host" (above). Two processes are documented as driving
herdr directly through this SDK: **butchr**, the software-factory daemon, and
**candlestix** (see the top-level README's "Why it exists"). The recommendation
is **butchr**:

- The motivating incident for this whole epic (DROVR-37) — "a new Claude Code
  dialog once froze a batch of *epic agents* for hours while herdr reported
  every one of them as idle or done" (README) — is stated in butchr's own
  fleet vocabulary (project/epic/story/task tiers exist only in butchr's
  model), not candlestix's.
- candlestix is a separate, smaller consumer currently slated to be folded
  into butchr (butchr's own BUTCHR-391, still open) rather than grown; new
  automation added to it now would need rewiring once that consolidation
  lands.
- butchr already owns the trust relationship and the live socket to the
  panes it hosts (via `hostResident`/`listResidents` and its own pane
  bookkeeping), so it can call `autoAnswerPermissions` with no new process
  gaining key-pressing access to those panes.

**Cadence: a dedicated interval, not piggybacked on butchr's own reconcile
tick, in the same 15–30s order of magnitude butchr already polls at.**
butchr's daemon already runs a reconcile/admission poll on a measured
~15-second cadence under load (its own BUTCHR-117 finding). Do not hang the
permission scan off that same tick: a `reconcileNow` failure already stalls
other poll-driven work in that loop (also BUTCHR-117), and a permission scan
has no reason to share that failure mode. Instead, a standalone interval —
every 15–30s is a reasonable starting point, tunable once real pane counts
are measured — calling `autoAnswerPermissions` once across every pane butchr
currently hosts, with `readTimeoutMs` set comfortably below the interval
(e.g. 10s) so one wedged pane's attempt can't still be running when the next
tick fires.

Justification: `listPendingPermissions` costs one `agent.read` per live
Claude pane per pass — the same shape of call butchr's status polling already
makes — so an additional pass at this cadence is one more read per pane per
cycle, not a new class of load. Against that: the DROVR-37 incident measured
agents frozen *for hours* with the dialog untouched; bounding the wait to a
15–30s poll interval is a two-to-three-orders-of-magnitude improvement, and
there is no benefit to polling much faster than that, since the mechanism
only matters for the case where no human is watching the pane at all.

Because the host lives in a different repo (butchr, not drovr), it is not
wired here. Filed as **DROVR-42** (`file_where_it_belongs`, an unlinked
orphan ticket carrying this recommendation and a definition of done, since no
existing epic already covered it).
