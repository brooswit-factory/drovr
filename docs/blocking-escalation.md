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
| `permission` | the tool name (e.g. `Bash command`)                                       | Reported only when the caller's own answering pass (see `docs/permission-approval.md`'s `approvePermission`/`autoAnswerPermissions`) will actually answer it; escalated otherwise (see "The no-stored-rule shape" below). |
| `unknown`    | —                                                                          | Reported, and — when the shape can be read with confidence — carries `dialog: { question, options }` verbatim for an escalation payload. |

`BlockingPrompt.keys`, `BlockingPrompt.dialog` and `BlockingPrompt.permission`
are all additive, optional fields: a consumer reading only
`kind`/`name`/`excerpt` (as before this release) is unaffected.
`BlockingPrompt.permission` (`kind: "permission"` only) is the full parsed
`PermissionPrompt` — `tool`, `request`, `question`, `options`, `cursor`,
`promptId` — so a caller can decide for itself whether ITS OWN answering
scope (a policy only the caller knows) will answer a given prompt, via
`optionFor` (now exported from `permission-approval.js`), without re-reading
the screen.

## The no-stored-rule shape, and the escalation gap it exposed (FACTORY-146/FACTORY-318)

Claude Code's static bash analyser marks some commands `too-complex` — a
whole family of reasons (a brace containing a quote character, a zsh `<N-M>`
numeric-range glob, a lone surrogate, control characters, and more; see
`docs/permission-approval.md` for the full list) that share one consequence:
no permission rule can be derived from a `too-complex` command, so Claude
never builds the `"Yes, and don't ask again for: …"` stored-rule option for
it. The dialog still classifies as `permission` — recognition was never the
problem — but it collapses to exactly three options: `Yes` / `Yes, and
switch to auto mode …` / `No`.

That matters because `autoAnswerPermissions`'s default scope, `"always"`,
answers a `permission` dialog only by finding a `"Yes, and …"` stored-rule
option (excluding auto mode) — this shape has none, so an `"always"`-scoped
answering pass skips it, pressing nothing. Before this fix, `poll()` routed
**every** `permission`-kind dialog straight to `outcome: "reported"`, on the
unconditional assumption that some other flow would answer it. When that
flow declined (this shape, under `"always"`), the pane was **neither
answered nor escalated** — recognised, but silently stuck, exactly the
"lands as a silent fleet-wide stall instead of a loud escalation" failure
mode this whole mechanism exists to close.

**Fixed:** `createBlockingEscalationWatcher` now takes a required
`permissionScope: PermissionScope` (`BlockingEscalationOptions`) — the exact
scope the caller's own answering pass actually runs, never defaulted or
guessed here, because guessing it wrong reproduces the same gap in the other
direction (escalating a dialog the pass would in fact have answered, or
staying silent on one it doesn't). Every poll, a `permission` dialog is
checked with `optionFor(permission, permissionScope)`: found means the
existing flow still owns it (`outcome: "reported"`, unchanged); not found
means it escalates through the exact same `onUnknownDialog` hook and
`(pane, fingerprint)` episode tracking an `unknown` dialog uses — fingerprint
and payload assembled from the permission prompt's own `tool`/`request`/
`question` (not the bare generic "Do you want to proceed?" question alone),
so that two different `too-complex` commands — which, for this shape, all
render the identical question and the identical three options — still
fingerprint distinctly instead of colliding on one shared identity.

Under `scope: "once"` (`optionFor` finds plain `"Yes"` at index 0, present on
every dialog this shape produces) this dialog IS answered by the existing
permission flow and is never escalated — no behaviour change for a caller
already on that scope. The gap only manifested for a caller on `"always"`
(`autoAnswerPermissions`'s own default when no `scope` is passed), or one
whose scope, for whatever reason, didn't match what its answering pass
actually ran — which is exactly why establishing which scope the daemon
that owned the originally-stalled panes ran is part of FACTORY-318's own
definition of done, and why that determination has to come from the host's
own configuration/logs, not be asserted here: this repo has no visibility
into a live consumer's runtime scope.

Real captures (`claude 2.1.251`, `claude --permission-mode default` in an
isolated scratch directory, 2026-09-26) of two `too-complex` reasons —
`Contains brace with quote character (expansion obfuscation)` and `Contains
zsh <N-M> numeric-range glob` — are committed at
`test/fixtures/too-complex-permission/`, exercised by
`test/permission-approval.test.ts`, `test/blocking-prompts.test.ts` and
`test/blocking-escalation.test.ts`. See the PR description for exactly how
they were produced (env vars stripped so the capture session isn't itself
detected as a nested Claude Code child).

## AskUserQuestion: `dialog` is now populated, plain or side-by-side with a preview

FACTORY-111/FACTORY-113. A Claude Code `AskUserQuestion` dialog is a numbered
menu (`parseNumberedDialog` in `src/blocking-prompts.ts`), so it reaches
`describeUnknownDialog` like any other unrecognised menu — but two shapes of
it used to defeat that function, each a different way: a `preview` on any
option switches Claude Code to a side-by-side layout (a boxed preview
column right of the option list, box-drawing borders, a
`✂ N lines hidden` marker when the preview is too tall to fit), and that
layout used to make the function return `undefined` outright (no
fingerprint, no `ANSWER` path, a person had to intervene on the pane). The
plain layout, by contrast, was recognised — but its "Chat about this"
trailer read as a real, numbered option, so the dialog it returned
silently carried a phantom extra option: a boss answering by number could
press that meta-action instead of a genuine choice, and nothing flagged
the mismatch.

Measured live (2026-09-26, claude 2.1.251) against a fresh pane, not
reconstructed:

- `Notes: press n to add notes` and the trailing "Chat about this" line
  render on **every** `AskUserQuestion` dialog, preview or not — but only
  the preview layout adds the `Notes:` line; the plain layout goes straight
  from the options to a separator and "Chat about this". Either way, a
  full-width separator (`─{10,}`) always sits directly before "Chat about
  this", which is why `parseNumberedDialog` now stops treating lines as
  options at that separator rather than reading "Chat about this" itself as
  one (it's numbered in the plain layout, unnumbered in the side-by-side
  one — both observed).
- The side-by-side layout drops each option's own `description` from the
  screen entirely (only the preview is shown) and, in exchange, can wrap a
  long label onto a second physical line with no number of its own — the
  exact shape a plain dialog uses for a `description` line instead. Telling
  them apart isn't a matter of the line's own shape (both are indented text
  right after an option); it's whether the *screen* has a preview column at
  all. `parseNumberedDialog` only folds such a line into the option above it
  when it does.
- Multi-select (`multiSelect: true`) renders each option as `[ ] label`
  (bracket bleeds into the label as read today) inside a `←  ☐ … ✔ Submit
  →` tab bar instead of the single-select `☐ …` header — observed, not
  fixed; nothing in the required scope exercises it.

Fixtures for all three required shapes (plain, a short preview, a
truncated one) are real captures in `test/blocking-prompts.test.ts` — see
that file's comment for how they were taken.

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
    // Also fires for a `permission` dialog `permissionScope` (below) cannot
    // answer (FACTORY-318) — same payload shape, `question`/`options`
    // assembled from the permission prompt's own tool/request/question.
  },
  async onDialogResolved({ paneId, fingerprint }) {
    // The same episode's dialog is no longer on screen with the same
    // fingerprint: it was answered, the pane closed, or a different
    // dialog (a new fingerprint) replaced it.
  },
}, {
  // The scope YOUR OWN autoAnswerPermissions call actually uses — required,
  // never defaulted (see BlockingEscalationOptions's own doc comment for why
  // guessing this is exactly the FACTORY-318 gap in the other direction).
  permissionScope: "once",
});

// Once per poll tick, on every Claude pane herdr reports:
const outcomes = await watcher.poll(client);
```

Per poll, for every Claude pane:

- A known-safe `startup` prompt (`keys` present) is pressed
  (`agent.sendKeys`) — never escalated.
- `mcp-approval` is reported (`AutoHandleOutcome`'s `"reported"`) — approval
  travels on the launch, unchanged; the hook is never called for it. A
  `permission` prompt is reported the same way ONLY when `permissionScope`
  finds an option on it (the existing answering flow still owns it);
  otherwise it escalates through the same path as an `unknown` dialog (see
  "The no-stored-rule shape" above).
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
