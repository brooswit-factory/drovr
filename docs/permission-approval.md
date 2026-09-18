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
  auditPath: "/var/lib/bakr/permission-approvals.jsonl",
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
