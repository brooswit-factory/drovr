# Blocking-dialog detection, auto-answer, and the escalation hook

FACTORY-46 (FACTORY-44). Principle from the owner: **any blocking dialog is
Drovr's job to detect and handle** — a host (Butchr, or any other consumer)
must not keep its own dialog list. This page describes the general mechanism
and the one new dialog it teaches Drovr to answer by name.

## What Drovr recognises today

`classifyBlockingScreen` (`src/blocking-prompts.ts`) is the single entry
point: given one pane's screen text, it says what — if anything — that pane
is waiting on.

| `kind`       | `name`                                                                  | Drovr's behaviour |
|--------------|--------------------------------------------------------------------------|--------------------|
| `startup`    | `trust`, `development-channels`, `auto-mode-onboarding`, `fullscreen-renderer` | Answered: `keys` is present and safe to press. |
| `startup`    | `mcp-approval`                                                            | Reported only. Approval travels on the launch (`mcpServersApproved`), never pressed here. |
| `permission` | the tool name (e.g. `Bash command`)                                       | Reported only. See `docs/permission-approval.ts`'s `approvePermission` for the deliberate, operator-driven approval flow. |
| `unknown`    | —                                                                          | Reported, and — when the shape can be read with confidence — carries `dialog: { question, options }` verbatim for an escalation payload. |

`BlockingPrompt.keys` and `BlockingPrompt.dialog` are both additive, optional
fields: a consumer reading only `kind`/`name`/`excerpt` (as before this
release) is unaffected.

## The fullscreen-renderer "dialog": SPECULATIVE, likely does not exist as written

FACTORY-44's own description: a managed session hit Claude Code's first-run
"Claude Code's fullscreen renderer didn't finish starting last time…" and
sat blocked, with nothing recognising it. `classifyStartupPrompt`
(`src/resident-host.ts`) added a matcher for this wording, gated
conservatively — but **reviewing this ticket turned up evidence that this
phrase is very likely NOT a dialog at all**, and the matcher as written
probably never fires on anything real.

**What was checked (2026-09-26):** no fixture, log, or live capture of an
interactive dialog carrying this wording exists anywhere in this checkout —
only the ticket's own prose. `strings` run directly against the installed
`claude` 2.1.283 binary (`~/.local/share/claude/versions/2.1.283`) DOES
contain the exact phrase, twice, but both are non-interactive notices, not
dialogs — no options, no footer, nothing to answer:

> Claude Code's fullscreen renderer didn't finish starting last time on
> this machine, so this launch is using the classic renderer. It will try
> fullscreen again next launch; /tui default keeps the classic renderer.

> Claude Code's fullscreen renderer has repeatedly failed to start on this
> machine, so it has been turned off here. Run /tui fullscreen to try it
> again (this also resets after an update).

A screen carrying either string as-is is not a menu `classifyStartupPrompt`
could ever answer — there is nothing to press. The matcher (`fullscreen
renderer` AND `didn't finish start`, both required, THEN an explicit
`Not now` option before it presses anything) is written so that on a real
screen carrying one of these notices, `keysToChoose` finds no menu, returns
undefined, and this correctly falls through to `unknown-blocking` — never
pressing a key on a non-dialog. It is kept only as a conservative fallback
in case some OTHER, genuinely interactive variant of this text exists that
this checkout has not seen; **that is unconfirmed**. It is deliberately
distinct from the separate, already-recognised "Try the new fullscreen
renderer?" opt-in offer (which never contains "didn't finish start") — that
one IS interactive, and reuses the same `Not now` answer as Butchr's fleet
convention for it (`brooswit-factory/butchr` `src/agents/prompt.ts`),
independently of whether the recovery-dialog branch above ever fires.

**Before relying on this for anything:** find out whether the pane that
motivated FACTORY-44 was actually blocked on an interactive dialog, or on
something else entirely (the notice above, mid-render, a different prompt
altogether). If a real interactive dialog does exist, capture its actual
screen text (`agent.read` with `source: "visible"`) and check it against
`classifyStartupPrompt`'s regexes before trusting this matcher to do
anything.

## The host-neutral escalation hook

`createBlockingEscalationWatcher` (`src/blocking-escalation.ts`) is the
general mechanism for everything the table above reports but does not
answer. A host calls `watcher.poll(client)` once per fleet poll; the watcher
carries `(pane, fingerprint)` episode state in its own closure across polls
— never in Drovr's exports, never in the host's ticket system — so Drovr
never needs to know whether the host has an issue key, a workspace, or
neither.

```ts
import { createBlockingEscalationWatcher } from "@brooswit/drovr";

const watcher = createBlockingEscalationWatcher({
  async onUnknownDialog(escalation) {
    // escalation: { paneId, label, sessionId, cwd, herdrStatus,
    //               question, options, fingerprint }
    // cwd is Drovr's own identity for a pane with no issue key (a managed
    // session is named only by its definition path) — verify it against
    // your own workspace layout; Drovr only forwards what herdr reports.
  },
  async onDialogResolved({ paneId, fingerprint }) {
    // The same episode's dialog is no longer on screen with the same
    // fingerprint: it was answered, the pane closed, or a different
    // dialog (a new fingerprint) replaced it.
  },
});

// Once per poll tick, on every Claude pane herdr reports:
const outcomes = await watcher.poll(client);
```

Per poll, for every Claude pane:

- A known-safe `startup` prompt (`keys` present) is pressed
  (`agent.sendKeys`) — never escalated.
- `mcp-approval` and `permission` prompts are reported (`AutoHandleOutcome`'s
  `"reported"`) — their existing flows are unchanged; the hook is never
  called for them.
- A genuinely `unknown` dialog whose shape was read with confidence
  (`dialog` present) escalates exactly once per `(pane, fingerprint)`
  episode: the fingerprint is a content hash of the question and options,
  so a cursor moving between polls does not create a new episode.
- Once that pane no longer shows the same fingerprint, `onDialogResolved`
  fires once. A pane that goes **unreadable** mid-episode (a hung or
  erroring `agent.read`) is left open, never resolved on a guess — the same
  discipline `scanBlockingPrompts` already applies to "couldn't check"
  versus "not blocked".
- A hook rejection is caught per-pane (`outcome: "hook-failed"`) and never
  fails the rest of the poll.

Never call `poll` concurrently on the same watcher instance — two
overlapping polls would race the same open-episode state.

Drovr ships no consumer of this hook itself. What a host does inside
`onUnknownDialog` — comment on an issue, write a workspace note, page an
operator — is entirely the host's own design; Drovr's contract ends at
calling it with a verified, verbatim payload once per episode.
