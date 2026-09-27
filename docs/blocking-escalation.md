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

## The login-expired condition (FACTORY-360/FACTORY-357): a deliberately separate, transcript-only watcher

2026-09-26 20:47 PT: a whole butchr daemon's worth of Claude panes (13) hit
Claude Code's own OAuth expiry at once, every pane printed `Login expired ·
Please run /login`, and nothing escalated for ~13 hours — a human found it
by accident. `classifyBlockingScreen`'s `WAITING_FOOTER` gate is why: a
login-expired pane draws no dialog and so no footer, so it never enters
`prompts` at all, however faithfully drovr recognises the string elsewhere
(`classifyBlockingText`, `classifyClaudeTranscriptRecord` — see
`docs/background-launch.md`).

**Why this is NOT simply "recognise the string in `classifyBlockingScreen`",
even though that was the first fix attempted for this story.** Measured on
the incident host (FACTORY-357 comment 26492): the last genuine auth
failure on the incident session was `2026-09-27T16:40:35Z`. At
`2026-09-27T17:22:01Z` — **41 minutes later** — that exact pane's screen
still carried `● Login expired · Please run /login` in scrollback, while in
that same second and the following 23 seconds the pane successfully
answered five tool-permission prompts and was doing real work. The
authentic error string, byte-identical, sat on a completely healthy pane's
screen for 41+ minutes after the condition had cleared. This is not a
near-miss a sharper regex could fix — the stale text and the live text are
the SAME string, only old, so **no detector reading screen text can tell
them apart.** Independently, Claude's own status-bar footer `Not logged in
· Run /login` is *also* stale (the client only re-checks credentials per
call and never updates the footer live) — a second, different-string,
independent stale-text hazard. Since this alert is designed to page a
human and fires on **first detection with no debounce** (nothing downstream
filters a false positive), a false alarm here is worse than the silence it
replaces: it trains people to ignore the alert and recreates the original
bug with extra steps.

**The authority is instead the pane's transcript, plus recency — never
screen text, and `createLoginExpiredWatcher` (`src/login-expired-escalation.ts`)
never reads a pane's screen at all**, not even as a pre-filter: its client
type exposes only `agent.list()`, so it is structurally incapable of
reading a screen or sending a key, not merely disciplined not to. Per
Claude pane, it reads the pane's own native transcript incrementally
(`readClaudeTranscriptTail`) and walks new records in order:

- A record `classifyClaudeTranscriptRecord` recognises as the structural
  login-expired tag (`type: "assistant"`, `isApiErrorMessage: true`,
  `error: "authentication_failed"`) is a failure.
- Any other genuinely successful (non-error) `type: "assistant"` completion
  after it is proof the API call succeeded again — the real "cleared"
  signal, not a tool result (a tool can execute locally without a live
  model call) and never the mere absence of the string on screen.
- Whichever of these is the pane's LATEST relevant turn decides the current
  state. A screen or transcript record that merely QUOTES the string in
  narration or a pasted ticket comment never matches at all: recognition is
  structural-tag-only (`classifyClaudeTranscriptRecord` never inspects
  prose), the same self-sustaining-loop hazard `describeUnknownDialog`
  already guards against for `unknown` dialogs (KAN-756) — sharper here,
  since this very doc and the story's own tickets all contain the literal
  string.

```ts
import { createLoginExpiredWatcher } from "@brooswit/drovr";

const watcher = createLoginExpiredWatcher({
  async onLoginExpired(escalation) {
    // { paneId, label, sessionId, cwd, herdrStatus, kind: "login-expired",
    //   detail, episodeId }
    // NO question, NO options, NO fingerprint framed as an answer token —
    // there is no ANSWER that fixes an expired OAuth token, only a human
    // doing a real browser re-login (startClaudeLogin). Never wire
    // episodeId as something a host can echo back.
  },
  async onLoginExpiredResolved({ paneId, episodeId, reason }) {
    // reason: "recovered" | "pane-gone" | "superseded" — a closed union a
    // host must exhaustively switch on, never just "resolved". Only
    // "recovered" means a LATER successful transcript turn was seen — the
    // real "credential is back" signal. "pane-gone" means the pane vanished
    // from agent.list() entirely (closed); it says NOTHING about whether
    // the credential recovered — panes churn on their own (a daemon
    // respawn, the reconciler replacing a pane) while the credential can
    // still be dead. "superseded" means a NEW failure replaced this episode
    // on the SAME still-live pane before it ever recovered (the ordinary
    // shape of a dead credential being retried) — a new `onLoginExpired`
    // for the replacement episode follows immediately on this same pane.
  },
});

const outcomes = await watcher.poll(client); // once per fleet poll, like createBlockingEscalationWatcher
```

### Episode identity: `episodeId`, not a fingerprint

`escalation.episodeId` is derived from the failing transcript record's own
`uuid` (falling back to its `timestamp`) — fields Claude Code assigns once
when it writes the record, never recomputed from scrollback, an excerpt, or
a line position. This matters because of a **measured, unrelated defect
this story deliberately avoided repeating**: FACTORY-146/FACTORY-356 found
that drovr's existing `promptId` (`sha256([tool, request, question,
options])`) becomes a function of scrollback once its recognition gate is
relaxed without also replacing its body delimiter — the SAME dialog
produced four different ids (`6167954f4c2e2c87` / `782555212a3c2e20` /
`d8a6f1be5cf11a92` / `0cb0e1dbb9f66a52`) as 0/3/9/20 unrelated chatter lines
were prepended ahead of a real capture. Because this alert fires on first
detection with no debounce, an unstable id would not degrade gracefully —
every poll would look like a brand-new episode, so one dead credential
would emit an unbounded stream of "new" host-wide alerts: the same
cry-wolf failure this story exists to prevent, arriving by a different
road. `test/login-expired-escalation.test.ts` proves the anchor-based id is
immune to this by the same technique — prepending 0/3/9/20 synthetic
chatter records ahead of the real failure record and asserting the
resulting `episodeId` (and `detail`) are identical across every N. A
failure record carrying neither `uuid` nor `timestamp` is treated as **no
usable evidence at all** rather than shipped with an unstable id — an
unstable identity is worse than no identity, because a host could no longer
tell one episode from many.

### Host-wide blast radius

One expired credential kills every pane on a daemon at once. This watcher
deliberately stays **per-pane**, matching `createBlockingEscalationWatcher`'s
own shape, rather than inventing host-grouping logic drovr has no way to
verify (it knows panes, not which daemon or fleet owns them). A host
collapses N simultaneous `onLoginExpired` calls into one alert the same way
it already tracks its OWN episode state for anything else: open a
host-level "credential dead" episode on the first `onLoginExpired` it
receives while none is open, suppress/aggregate every `onLoginExpired` that
arrives while it stays open, and close the host episode once it has
received `onLoginExpiredResolved` with `reason: "recovered"` for every pane
currently inside it.

**Only `reason: "recovered"` is evidence the credential itself is back.** A
host must not close its fleet-wide alert on an unqualified "any
`onLoginExpiredResolved` arrived" — that event ALSO fires with
`reason: "pane-gone"` (the pane simply vanished from `agent.list()`, which
says nothing about the credential — panes churn on their own during exactly
this condition) and with `reason: "superseded"` (a new failure replaced the
episode on the same still-live pane; the credential never recovered, and a
new `onLoginExpired` for the replacement follows immediately). Treating
either of those as "fleet recovered" would silence a still-live
"credential dead" alarm while the outage continues — worse than the
13-hour silent-stall bug this whole story exists to fix, because a
switched-off alarm actively tells a human the outage is over while it is
still running, rather than just staying quiet. If a host's policy is "any
single recovery signals the whole fleet is likely back", it must wait for
`reason: "recovered"` specifically (not merely "resolved") on any one pane
before applying that shortcut fleet-wide — or design its own policy instead.

### Never answered, never resolved on a guess

- This watcher's `EscalationClient` type exposes only `agent.list()` — no
  `read`, no `sendKeys` — so it cannot press a key on a login-expired pane
  even by accident; there is no `startClaudeLogin`-style auto-recovery
  wired in here (that stays a human doing a real browser flow).
- A pane with no native session identity (`sessionId`/`cwd` absent) or
  whose transcript read fails this poll is reported `unreadable` and any
  already-open episode on it is left OPEN, exactly like
  `scanBlockingPrompts`'s "couldn't check" discipline — never resolved on a
  guess.
- A pane that disappears from `agent.list()` entirely (closed) with an open
  episode IS resolved — there is no longer a pane to page about.

### What this is not

`login-expired` in `docs/background-launch.md`'s blocking-condition table
is a *launch-time* check (`classifyBlockingText`/
`classifyClaudeTranscriptRecord` reading a launch's own settle-window
output before a session is handed back) — a different mechanism, answering
a different question ("did this launch itself start into a dead
credential?"), and it is unaffected by anything in this section.
