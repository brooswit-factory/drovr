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
