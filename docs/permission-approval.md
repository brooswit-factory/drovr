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
- **A throw after `approving` never escapes.** If `sendKeys` itself rejects
  (herdr socket gone, pane closed, a timeout), the call never throws out of
  `approvePermission`: it makes a best-effort outcome `appendAudit`
  (`keys-failed`, same `attemptId`) and returns `ok: false` — the detail says
  whether a key may have reached the pane is unknown. A throw inside the
  verify loop itself (`deps.now`/`deps.wait`; a `readScreen` failure is
  already caught and treated as "still showing the prompt") is the same shape
  under a distinct reason, `verify-failed`, because by then `sendKeys` did
  resolve — the ambiguity is only over whether the prompt cleared, not
  whether the keys landed. Either way the outcome write failing is itself
  swallowed (`.catch(() => undefined)`, like every other outcome write), so
  it can never mask the `ok: false` result, and the keys are never retried.
  Treat both as a **failure**, not a refusal — like `not-cleared`, not like
  `prompt-changed` or `option-missing`.

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
  scan; `invalid-operator`, `audit-failed`, `not-cleared`, `keys-failed` and
  `verify-failed` map to `failed`, because those name a problem with the
  attempt itself, not a stale read. A pane that throws, or that misses its
  `readTimeoutMs` deadline, is also `failed`.

**Known limitation, not fixed here:**

`autoAnswerPermissions` still calls `listPendingPermissions` (not
`scanPendingPermissions`) as its scan step, so an unreadable pane found
during *that* scan is silently absent from its results rather than becoming
a `failed` entry — `readTimeoutMs` on `autoAnswerPermissions` only bounds the
**approve** attempt for a pane the scan already found, same as before. A
caller that needs `autoAnswerPermissions` itself to see unreadable panes
should scan with `scanPendingPermissions` first and reconcile the two lists;
that wiring is left to the caller, not fixed here.

## Scanning without losing an unreadable pane: `scanPendingPermissions`

Fixed by DROVR-33: `listPendingPermissions` used to skip a pane whose screen
it could not read — `readScreen(...).catch(() => "")` turned a read failure
into an empty screen, which classifies as "no pending prompt", the same
return shape as a pane genuinely showing nothing. Nothing told a caller the
pane had been missed. Its scan also had no deadline of its own: a hung
`agent.read` held the whole pass open until the *caller's* own timeout
(bakr passes 15s), far past a status poll's usual ~2s budget.

```ts
const { pending, unreadable } = await scanPendingPermissions(client, {
  readTimeoutMs: 1500,   // optional; this is the default
});
// pending:    same shape as listPendingPermissions's result
// unreadable: [{ paneId, label, sessionId, cwd, herdrStatus,
//               reason: "timeout" | "error", detail }]
```

- **Every unreadable pane is reported, never silently dropped.** A pane whose
  `agent.read` rejects is `reason: "error"`; one that has not settled by
  `readTimeoutMs` is `reason: "timeout"`. Both carry `herdrStatus` alongside,
  because herdr often calls these panes idle while they sit unreadable.
- **Reads run in parallel, bounded per pane.** The scan takes roughly the
  slowest read, capped by `readTimeoutMs` (default 1500ms) — not the sum of
  every pane's read, and never unbounded.
- **`agent.list()` failing still rejects.** Only a per-pane `agent.read` is
  bounded and caught; a caller that cannot even list its panes gets a
  rejection, which it maps to "couldn't check anything" — a stronger signal
  than an empty result.
- **`listPendingPermissions` is now a thin wrapper** over
  `scanPendingPermissions` that drops the `unreadable` list, so its signature
  and behaviour are unchanged for every existing caller. Use
  `scanPendingPermissions` directly to tell "no pending prompt" apart from
  "could not check".

The same fix applies to blocking prompts: see `scanBlockingPrompts` in
`src/blocking-prompts.ts`, which shares this `UnreadablePane` shape (from
`src/pane-scan.ts`) and the same per-pane deadline.

## A throw after `approving` used to escape, leaving the audit record stranded

Before this fix, `approvePermission` wrote the `approving` audit record and
then called `client.agent.sendKeys` with no guard. A `sendKeys` that rejected
(herdr socket gone, pane closed, a timeout) escaped as a thrown exception:
the caller got an error instead of an `ApprovePermissionResult`, and the
audit trail was left holding `approving` with no matching outcome line for
that `attemptId` — the same *stranded record* class of gap DROVR-33 and the
wrapped-option bug below both belong to, just at a different point in the
call. `deps.now()`/`deps.wait()` inside the verify loop (run after `sendKeys`
resolves, to confirm the prompt actually cleared) could throw the same way;
`readScreen` failures inside that loop were already caught.

Fixed: both are now caught. A throwing `sendKeys` returns `{ ok: false,
reason: "keys-failed", detail }`, where the detail says whether a key may
have reached the pane is unknown. A throw inside the verify loop returns the
same shape under `reason: "verify-failed"` — a distinct reason because by
that point `sendKeys` already resolved, so the ambiguity is only over whether
the prompt cleared, not whether the keys landed. Both make a best-effort
outcome `appendAudit` (same `attemptId`) before returning, and a failure to
write *that* record is itself swallowed so it can never mask the result —
matching every other outcome write in this function. Keys are never retried.
`autoAnswerPermissions` maps both reasons to `failed` (see "Result mapping"
above), like `not-cleared` and `audit-failed`.

Covered by regression tests in `test/permission-approval.test.ts`: a fake
client whose `sendKeys` rejects, and one whose outcome-audit write also
rejects after that.

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
case DROVR-37 exists to fix.

**This was silently indistinguishable from "genuinely no pending prompt."**
`classifyPermissionPrompt` returning `undefined` is the same return value for
a pane showing this dialog and a pane showing nothing of interest at all —
there was no separate signal (an error, a partial match, a different return
shape) marking "a dialog is here but couldn't be parsed." `listPendingPermissions`
therefore omitted a genuinely blocked pane with no indication anything had
gone wrong, which is exactly the class of failure that makes this dangerous:
nothing in the pass, the audit log, or the result array said the pane had
been missed.

This is the same *class* of failure DROVR-33 tracked (an unreadable pane also
read as "no prompt", with no per-read deadline in `listPendingPermissions`'s
own scan) — **related, but distinct, and not fixed here.** DROVR-33 is about
the *screen read itself* failing (a pane that can't be read at all, or hangs
being read); this was a *successful* read of a well-formed, on-screen dialog
that the *parser* then silently mis-cased due to terminal-width wrapping. Both
end at the same observable symptom (a real dialog absent from
`listPendingPermissions`'s results, no error raised), but the fix for one does
not touch the other: this fix changes only how `classifyPermissionPrompt`
folds wrapped lines; it has no effect on DROVR-33's read-level gap, which is
`scanPendingPermissions`'s own `unreadable` list (above).

Fixed: a non-option line now folds into the option it continues when it's
indented continuation text (matching the wrap actually measured); a blank
line, an unindented stray line, the "Esc to cancel" footer, or a fresh
separator/question still ends the scan. Covered by regression tests built
from this exact raw screen in `test/permission-approval.test.ts`, plus
synthetic variants for a wrapped option at position 3, a wrapped non-"Yes,
and…" option 2, and an unindented stray line (which must end the scan, not
fold in).

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
