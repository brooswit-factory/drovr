# Approving a pending Codex approval prompt (Codex lizard mode)

Codex lizard mode is the Codex-vendor twin of Claude lizard mode
(`docs/permission-approval.md`): a Codex session launched in its **manual**
approval mode — i.e. `buildAgentStartParams` (`src/agent-runtime.ts`) called
with `bypassApprovalsAndSandbox: false`, which omits
`--dangerously-bypass-approvals-and-sandbox` — stops on Codex's own
approval dialogs and waits for someone at its terminal. `src/codex-permission-approval.ts`
lets an operator, or a host acting for one, answer that prompt from anywhere,
always with the plain approve-once option and nothing else.

A Codex session still launched WITH `--dangerously-bypass-approvals-and-sandbox`
(today's default — see `agent-runtime.ts`) never shows any of these dialogs at
all, so scanning or auto-answering it is a harmless no-op: **enabling Codex
lizard mode is entirely a launch-flag decision the host makes** (Butchr's
FACTORY-108), not a flag this module reads. Nothing here distinguishes a
"lizard-mode" Codex agent from any other Codex agent; it doesn't need to.

## What it answers, and what it cannot

Measured on **codex-cli 0.145.0** in a herdr pane (2026-09-26), one dedicated
`drovr-codex-probe` session created for this capture, never a shared or live
one. The exact raw captures are `test/fixtures/codex-approval/*.txt`.

**This module's `kind` is a classification of on-screen SHAPE, not of what
triggered the prompt** — see the wording table below for why "command
execution" and "network access" share one shape.

### `kind: "command"` — running a shell command outside the sandbox

```
  Would you like to run the following command?

  Environment: local

  Reason: Allow creating drovr-codex-probe-home.txt in your home directory?

  $ touch ~/drovr-codex-probe-home.txt

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `touch '~/drovr-codex-probe-
     home.txt'` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

A **network-access** escalation renders the **identical** shape and footer —
only the `Reason:` line differs:

```
  Reason: Allow network access to download example.com into the requested /tmp file?

  $ curl -sS -o /tmp/drovr-codex-probe-fixtures-net.html https://example.com
```

Codex has **no separate on-screen dialog for network access**; it is the same
"run a command" dialog with a network-flavoured reason. This module therefore
classifies both as `kind: "command"`. A caller that needs to tell them apart
can pattern-match `detail`'s `Reason:` text itself (e.g. `/network access/i`);
this module does not, to avoid inventing a distinction Codex itself doesn't
draw on screen.

### `kind: "file-edit"` — an apply_patch edit outside the sandbox

Drops the `Environment:`/`Reason:`/`$ …` block for a diff summary above the
question, and asks a different question:

```
• Added ~/drovr-codex-probe-edit.txt (+1 -0)
    1 +hello from codex edit


  Would you like to make the following edits?

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

`detail` is the diff-summary cell (`• Added …`/`• Updated …`/`• Deleted …`
plus its indented diff lines), found by walking back from the question to the
nearest such bullet — **not** the whole preceding user turn, which would also
be sitting directly above the diff in a live pane.

### `kind: "mcp-tool"` — calling a tool on a configured MCP server

A structurally different dialog: a labelled field list, up to four options
each carrying an inline description, and its own distinct footer:

```
  Field 1/1
  Allow the drovrprobe MCP server to run tool "danger_tool"?

  note: probe test

› 1. Allow                   Run the tool and continue.
  2. Allow for this session  Run the tool and remember this choice for this session.
  3. Always allow            Run the tool and remember this choice for future tool calls.
  4. Cancel                  Cancel this tool call
  enter to submit | esc to cancel
```

`detail` is `"<server>.<tool>"` (`drovrprobe.danger_tool` above), read
straight out of the question line. `options` keep Codex's inline description
padded onto each label; `onceOptionIndex`/the audit trail strip nothing —
`mcpLabel()` (private) is how this module tells `"Allow"` apart from
`"Allow for this session"` internally.

### Directory trust — a separate, pre-existing dialog

The directory-trust dialog Codex shows on first entering an untrusted
directory ("Do you trust the contents of this directory? … 1. Yes, continue
2. No, quit") is **not** one of the three kinds above — it is detected and
corrected by the pre-existing `src/codex-trust.ts` (marks the agent
`blocked`; does not answer it). This module never touches it.

### Wording → kind → answer key

| On-screen wording (question line) | `kind` | Approve-once option | Never chosen |
| --- | --- | --- | --- |
| `Would you like to run the following command?` | `command` | `Yes, proceed` (position 1) | `Yes, and don't ask again for commands that start with …` |
| `Would you like to make the following edits?` | `file-edit` | `Yes, proceed` (position 1) | `Yes, and don't ask again for these files` |
| `Allow the <server> MCP server to run tool "<tool>"?` | `mcp-tool` | `Allow` (position 1) | `Allow for this session`, `Always allow` |
| *(directory trust — separate dialog, see above)* | *(not this module)* | — | — |

Anything else that shows one of the two known footers (`Press enter to
confirm or esc to cancel`, `enter to submit \| esc to cancel`) or a
`Would you like to …`/`Field N/M` phrase, but doesn't match one of the three
shapes above, is reported as **`kind: "unrecognised"`** — see below. No other
approval kind was captured live; `--dangerously-bypass-hook-trust` (mentioned
in `codex --help`) suggests a hook-trust approval also exists, but it was not
triggered or observed in this checkout, so it is not in the table above and
is not fabricated here. It would surface today as `"unrecognised"` (a footer
match with an unknown title) rather than silently as "no prompt" — see the
next section.

## Never guessed at: `"unrecognised"`

A screen that carries one of the two known footers (or the generic
`Would you like to …`/`Field N/M` tripwire) but fails to parse into one of
the three known shapes — a missing "No"/"Cancel" option, a garbled dialog,
some future Codex version's wording this module has never seen — is
`{ kind: "unrecognised", excerpt }`, **never `undefined`**. Treating an
unparsed-but-approval-shaped screen the same as "genuinely nothing here" is
exactly the class of bug DROVR-41 found in the Claude classifier (a wrapped
option silently made a real dialog invisible); this module structures the
return type so that mistake can't reoccur by construction — `undefined` means
"nothing approval-shaped is on screen at all", full stop.

`scanPendingCodexApprovals` reports `unrecognised` panes in their own list,
separate from `pending` and `unreadable`. `autoAnswerCodexApprovals` **never**
presses a key at one: it writes an audit record (`outcome: "unrecognised"`,
the pane's excerpt as `detail`) and returns `outcome: "unrecognised"` in its
result — logged loudly, left for a human, never a guess.

## Guarantees

Same shape as `permission-approval.md`'s Claude guarantees, reusing
`permission-approval.ts`'s exported `defaultDeps`/`PermissionApprovalDeps` so
both vendors write to the same audit file under the same I/O and timing
defaults:

- **Only the prompt the caller saw.** The screen is re-read before any key is
  sent; a changed prompt (`promptId` hashes `kind`, `detail` and `options`,
  never `cursor`) is refused as `prompt-changed`.
- **Never a stored rule.** Only `"Yes, proceed"` / `"Allow"` is ever pressed —
  `onceOptionIndex` (exported) never returns the index of `"Yes, and don't ask
  again…"`, `"Allow for this session"`, or `"Always allow"`. There is no
  `"always"` scope for Codex the way Claude's module has one: approve-once is
  the only behaviour this module offers, by design — the ticket's own rule
  (FACTORY-106/FACTORY-107).
- **Audit first**, same JSONL file as Claude lizard mode. Records carry
  `vendor: "codex"` so a shared reader can tell the two apart; everything
  else — `ts, attemptId, operator, paneId, label, sessionId, promptId, scope,
  outcome` plus `kind`/`detail`/`option` — mirrors Claude's shape. `scope` is
  always the literal `"once"`.
- **Verified.** Success means the prompt left the screen (or the screen no
  longer shows *that* prompt at all — including turning into an
  `"unrecognised"` screen, which still counts as "cleared", never as "still
  showing the same prompt"). Keys that leave it in place are `not-cleared`.
- **A throw after `approving` never escapes** — `keys-failed` and
  `verify-failed`, same as Claude's module, for the same reasons.
- **Filtered by vendor, structurally.** `scanPendingCodexApprovals` only ever
  reads `agent.agent === "codex"` panes; a Claude pane is never touched by
  this module, and a Codex pane is never touched by `permission-approval.ts`'s
  Claude functions. Enabling one vendor's lizard mode cannot change the
  other's behaviour.

## Unattended: `autoAnswerCodexApprovals`

```ts
const results = await autoAnswerCodexApprovals(client, {
  auditPath: `${homedir()}/.local/state/bakr/permission-approvals.jsonl`, // same file as Claude
  operator: "drovr-auto",  // default; pass one only to override it
  readTimeoutMs: 10_000,   // optional per-pane deadline
});
// [{ paneId: "w1:p1", label, outcome: "answered", kind, detail }
//  { paneId: "w2:p1", label, outcome: "skipped", reason }
//  { paneId: "w3:p1", label, outcome: "unrecognised", excerpt }
//  { paneId: "w4:p1", label, outcome: "failed", reason, detail }]
```

One unattended pass over every Codex pane `scanPendingCodexApprovals` finds:
every `pending` prompt is answered with its plain approve-once option and
nothing else; every `unrecognised` pane is logged and left untouched (never
skipped silently — see above); one pane throwing, or missing
`readTimeoutMs`, is `failed` for that pane alone and never blocks another.
Same `readTimeoutMs` caveat as `autoAnswerPermissions`: it bounds the whole
per-pane `approveCodexApproval` attempt, not a single read, and does **not**
cancel it — a `timeout` result means the outcome is unknown, not "nothing
pressed"; check the audit log for that pane.

## Host wiring

Same recommendation as Claude lizard mode (`permission-approval.md`'s "Host
wiring" section): **butchr**, on the same standalone interval, calling
`autoAnswerCodexApprovals` alongside `autoAnswerPermissions` for every pane it
hosts. Because the host lives in a different repo, it is not wired here —
enabling `lizardMode` on a Codex agent definition, launching Codex without
`--dangerously-bypass-approvals-and-sandbox`, and calling this module on a
cadence are Butchr's job (FACTORY-108).

## Capturing new fixtures live

`scripts/probe-codex-approval-prompt.ts` is the opt-in probe used to capture
the `command`/`file-edit` fixtures above: it starts real `codex` in a named
`drovr-proof-*` herdr session (never a shared/default one), answers the
directory-trust dialog, sends a request likely to need approval, and prints
the resulting screen every 2 seconds so a human can read off the exact
wording and copy it into a fixture file. It does not attempt the `mcp-tool`
case — that additionally needs a companion MCP server (`codex mcp add`)
registered before Codex starts; the exact steps used for the 2026-09-26
capture are recorded in the FACTORY-107 PR description rather than automated
here, since it is a one-off setup rather than a repeatable proof.

**Never point this probe (or any manual capture) at zippy or another shared,
live host.** Every capture behind this module was taken in a disposable
session on a workspace host, cleaned up afterward.
