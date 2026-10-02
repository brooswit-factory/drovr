# Changelog

## 0.16.10

Approval dialogs whose option-2 label wraps and leaves a whitespace-only row
inside the option block are now recognised (FACTORY-603/604/605). Before, the
blank row ended the option list early, so the whole dialog was invisible
(`classifyPermissionPrompt` returned `undefined`) and sat unanswered. The
option-collection loop now skips a bounded run of such rows
(`MAX_OPTION_BLANK_RUN = 2`) and continues only when the next non-blank row is
a wrapped continuation or the next numbered option; a blank run followed by
`1.` (a second dialog), the footer, a question or a separator still ends the
list. Which option gets pressed is unchanged: a blank-row screen now behaves
exactly like its unwrapped twin at both scopes, so recognition now reaches the
wrapped "Yes, and don't ask again for: <command>" shape too, with the answer
decision it already had. Eight real, scrubbed captures (and their unwrapped
twins) back the equivalence tests under `test/fixtures/permission-blank-row/`.

## 0.16.9

macOS support for the native transcript readers (Claude, Codex, AGY, and the
Claude tail reader): `openSafe` (`src/native-transcript.ts`) now opens the
whole path once with `O_NOFOLLOW_ANY` on macOS 11+, so a symlink in any path
component is refused atomically, equivalent to the Linux per-component walk
through `/proc/self/fd` (which is unchanged). On macOS a directory is listed by
path rather than the pinned descriptor and every entry is re-opened by full path
through `openSafe`, so a swap in between cannot make a read leave the tree
(documented in the code). Other platforms still refuse. Tests now resolve
`os.tmpdir()` through `realpath` (`test/support/tmp.ts`), so the suite passes on
macOS. No change on Linux.

## 0.16.8

File-edit/Create-file approval dialog whose header has scrolled off the
pane is now recognised (FACTORY-460/580), with the safety bounds added since:
refuse when the opening `╌` border is off screen (FACTORY-583); a dialog
whose full path is not derivable is recognised but unanswerable, so it
escalates to a human (FACTORY-584/585, strict fail-closed); the backward
border scan is bounded to the dialog's own frame (FACTORY-586); and
recognition refuses when a second question line is on screen or the diff body
lacks the line-number gutter (FACTORY-587, `docs/permission-approval.md`
GUARD 6/7).

## 0.16.7

FACTORY-561 (minimum scope for an unattended Codex task on zippy, native
Windows/ConPTY): Codex's own directory-trust dialog ("You are in .../ Do you
trust the contents of this directory?") used to only flip a corrected
`agent_status` to `blocked` (`codex-trust.ts`, 0.1.0) — nothing actually
pressed it. `scanBlockingPrompts`/`classifyBlockingScreen`
(`blocking-prompts.ts`) now also scan Codex panes (previously Claude-only),
and recognise this dialog as a `kind: "startup"` prompt (`name:
"codex-trust"`) carrying the keys to press "Yes, continue" — so
`createBlockingEscalationWatcher`'s existing auto-answer loop presses it
exactly like a Claude startup prompt, with no separate Codex-specific
answering path.

- New `keysForCodexTrust` (`codex-trust.ts`) reads the on-screen cursor
  (`isActiveTrustDialog` already tolerates it on either option) and derives
  the keys to reach "Yes, continue", rather than assuming an option order.
- `isActiveTrustDialog`'s directory-heading pattern required a POSIX path
  (a leading `/`); widened to also accept a Windows drive path (`C:\...` or
  `C:/...`) or a UNC share (`\\host\...`), since no Windows/ConPTY capture
  of this dialog exists yet to confirm which form Codex actually prints
  there — flagged on FACTORY-561 for verification against a real run.
- `test/fixtures/codex-trust/pane-win32-reconstructed.txt` is a
  **reconstructed**, not a real, capture (CRLF line endings and a
  drive-letter cwd applied to the real Linux capture already used in
  `codex-trust.test.ts`) — see that fixture directory's README.
- The win32 Codex launch argv path (TOML literal strings for `--config`,
  FACTORY-573/574) and herdr key sending were reviewed, not changed here:
  nothing broken was found in this checkout, but neither was exercised
  against a real Windows pane — also flagged on FACTORY-561.
- Out of scope for this release (deferred by FACTORY-561's own narrowed
  scope): Claude Code on Windows (Git Bash, `.cmd` shims) and pinning
  `herdr >= 0.9.3` beyond this line.

## 0.16.6

FACTORY-571/FACTORY-573: on win32, herdr's Codex pane joins argv into a single
PowerShell `Start-Process -ArgumentList` string; that re-parse eats the
escaped `"` (and un-doubles the `\`) a TOML **basic** string relies on, so
every `--config key={...}` value Codex received had its quotes stripped —
`invalid type: string "{C:\\...={trust_level=trusted}}", expected a map in
projects`. drovr does not own that PowerShell hop and cannot change it; it
can stop depending on it.

- `tomlString`, `tomlStringMap`, `codexMcpArg`, `disabledCodexMcpArg`, and the
  inline `projects={...}` expression in `buildAgentStartParams` now take a
  `platform: NodeJS.Platform` (threaded from a new, optional second
  `buildAgentStartParams(launch, platform = process.platform)` parameter) and
  emit TOML **literal** strings (single-quoted, no escape processing) on
  win32 only. A literal string carries no `"` and does no backslash
  escaping, so it survives the `Start-Process` re-parse intact — verified by
  round-tripping every win32 `--config` value through `Bun.TOML.parse` for
  both a drive-letter and a UNC cwd.
- A value containing `'` or `"` cannot be represented as a TOML literal
  string; it throws a clear, actionable error naming the value rather than
  silently falling back to a basic string, which would reintroduce the bug —
  a `"` passing through unescaped is exactly the PowerShell re-parse hazard
  this fix exists to close (FACTORY-572). Keys go through the same
  `tomlString` function, so a header key containing `'` or `"` throws too.
  A raw newline, carriage return, or other control character (other than
  tab) also throws: TOML literal strings are single-line, and such a
  character has no representation in one.
- POSIX (`process.platform !== "win32"`) output is byte-identical to
  `0.16.5` — every existing assertion in `test/agent-runtime.test.ts` and
  `test/launch-inputs.test.ts` passes unchanged.
- **Residual, not closed by this fix:** a value containing a *space* is
  still wrapped in `"` by herdr's own `quote_windows_command_line_arg`, and
  that `"` faces the same `Start-Process` re-parse. A workspace path with a
  space, and the `prompt`/brief argument (which always has spaces), remain
  exposed through a mechanism drovr cannot fix from its side.
- Side effect, no separate work: `checkManagedAgentArgv` compares expected
  vs. observed argv and could not match on Windows because the observed
  `--config` values were mangled; quote-free values fix that incidentally.
- No Windows host was used to verify this; verification is the argv drovr
  emits, replayed through herdr's own quoting functions and through a real
  TOML parser (`Bun.TOML.parse`), as detailed on FACTORY-571's triage
  comment.

## 0.16.5

FACTORY-565: bump `@brooswit/herdr-sdk` from `^0.1.3` to `^0.3.0`, so drovr
(and butchr through it) can resolve the Windows-capable SDK. `^0.1.3` stops
below `0.2.0`, and `0.1.3`'s transport hardcoded `Bun.connect({ unix })` —
Unix-domain-only, with no Windows branch — so on native Windows, where herdr
listens on a named pipe (`\\.\pipe\<path>`) and the `.sock` file is only an
ownership marker (`<pid>:<nonce>`), every connection attempt failed with
"socket error".

- `@brooswit/herdr-sdk` `0.2.0` replaced the transport with `node:net`'s
  `Socket`, which handles both a Unix socket path and a Windows named pipe,
  honors `HERDR_SOCKET_PATH` (with `HERDR_SOCKET` kept as a deprecated
  fallback), and resolves the default socket path the same way herdr itself
  resolves its config dir. `0.3.0` refreshed the schema and wrappers for
  herdr 0.9.1 (protocol 22), adding 12 new methods (`enumerateSurface` now
  reports 103 methods across the same 12 services, up from 91). Neither
  release lists a `BREAKING` change.
- No source change was needed in drovr itself: `bun run typecheck` and
  `bun run build` were clean against the new SDK version. The only break was
  `test/parity.test.ts`'s hardcoded method-count sanity check, updated from
  91 to 103 to match the refreshed schema; drovr's own corrections and
  service-proxy plumbing are unaffected because they key off wire method
  names, not a fixed method count.

## 0.16.4

FACTORY-388: fingerprint unrecognised Codex approval dialogs for sighting
counts. Codex's unrecognised-dialog reporting (`autoAnswerCodexApprovals`,
`scanPendingCodexApprovals`) logged each sighting with only a free-text
excerpt, giving a host nothing stable to group repeated sightings of the
same dialog shape by.

- **`UnrecognisedCodexPrompt` gains `fingerprint`**: a hash of the excerpt
  with cursor glyphs (`›`, `❯`) normalised to a space rather than stripped,
  so the hash stays stable both while the cursor sits still and while it
  moves to a different option line. Present everywhere an unrecognised
  Codex screen is reported — `classifyCodexApprovalScreen`'s
  `unrecognised` result, `approveCodexApproval`'s refusal audit record,
  and `autoAnswerCodexApprovalResult`'s `"unrecognised"` outcome — so a
  host can build the same sighting-count-per-fingerprint monitoring
  already used for Claude's `unknown` dialogs (`blocking-escalation.ts`),
  scoped to Codex. Not a new Codex dialog recognizer, and no new detection
  surface beyond what FACTORY-107 already measured live.

## 0.16.3

FACTORY-373 (FACTORY-360, FACTORY-357): closes the 13-hour silent
credential-expiry gap — a whole daemon's worth of Claude panes hit Claude
Code's own OAuth expiry at once and nothing escalated, because
`classifyBlockingScreen`'s `WAITING_FOOTER` gate structurally cannot see a
login-expired pane (no dialog, no footer).

- **New: `createLoginExpiredWatcher(hook, deps?)`** (`src/login-expired-escalation.ts`,
  exported from the package root) — a host-neutral watcher for this
  condition, deliberately separate from `createBlockingEscalationWatcher`.
  Its authority is the pane's own Claude transcript plus a RECENCY rule
  (the auth failure must be the pane's LATEST relevant turn), never screen
  text: measured on the incident host, the authentic error string sat
  byte-identical in a healthy pane's scrollback for 41+ minutes after the
  condition cleared, while the pane was successfully doing real work — no
  regex over screen text can tell that apart from a live failure. This
  watcher never reads a pane's screen at all (its client type exposes only
  `agent.list()`), so it is structurally incapable of reading a stale
  screen or of sending a key to answer a condition that has no answer.
- `escalation.episodeId` is a content hash of the failing transcript
  record's own `uuid` (falling back to `timestamp`) — never anything
  screen- or scrollback-derived. FACTORY-146/FACTORY-356 measured that
  drovr's existing `promptId` becomes a function of scrollback once its
  gate is relaxed without replacing its delimiter (the same dialog
  produced 4 different ids as 0/3/9/20 chatter lines were prepended); this
  watcher's stability across the same N = 0/3/9/20 test is asserted in
  `test/login-expired-escalation.test.ts`.
- The escalation payload has no `question`, no `options`, no
  fingerprint-shaped-as-answer-token — there is no `ANSWER` that fixes an
  expired OAuth token, only a human doing a real browser re-login
  (`startClaudeLogin`).
- **`LoginExpiredResolved` carries a `reason: "recovered" | "pane-gone" |
  "superseded"` discriminator** — a closed union, not a loose string.
  `onLoginExpiredResolved` fires for three structurally different causes
  and nothing else in the payload lets a caller tell them apart: a real
  later successful transcript turn (`"recovered"`), the pane vanishing
  from `agent.list()` entirely (`"pane-gone"` — pane churn, says nothing
  about the credential), or a new failure superseding an already-open
  episode on the same still-live pane (`"superseded"` — the ordinary
  shape of a dead credential being retried, never a recovery). Only
  `"recovered"` is safe for a host to read as "the credential is back";
  see `docs/blocking-escalation.md`'s host-wide blast-radius section,
  corrected in this same release to remove the "any resolved signals
  fleet recovery" shortcut it used to (wrongly) offer.
- See `docs/blocking-escalation.md`'s "The login-expired condition"
  section for the full design, the 41-minute measurement, host-wide
  blast-radius guidance (deliberately per-pane, matching
  `createBlockingEscalationWatcher`'s own shape — a host composes its own
  host-wide dedup the same way it already tracks any other episode state),
  and why this is a different mechanism from the *launch-time*
  `login-expired` `BlockingCondition` in `docs/background-launch.md`.
- No existing behaviour changed: `classifyBlockingScreen`,
  `scanBlockingPrompts`, `createBlockingEscalationWatcher`, and the
  `unknown`/`permission`/`startup` classifications are untouched by this
  release — full existing suite still passes.

## 0.16.2

FACTORY-318 (FACTORY-146): closes a fleet-wide silent-stall gap. A `Bash`
permission dialog for a command Claude Code's own static analyser calls
`too-complex` (e.g. "Contains brace with quote character (expansion
obfuscation)", and sibling reasons — lone surrogate, control characters,
zsh `<N-M>` glob, etc.) has no stored-rule option at all, so `"always"`
scope never answers it and it used to be silently `reported`, never
escalated. This release also folds in everything `v0.16.1` shipped
(Codex lizard mode, `AskUserQuestion` recognition, the bundled approval
sound), merged into this branch from the `v0.16.1` tag.

- **`createBlockingEscalationWatcher(hook, options)`** — `options` (with a
  required `permissionScope: PermissionScope`) is now a **required second
  argument**; there is no default. A recognised `permission` dialog that
  the caller's own `permissionScope` cannot answer (`optionFor(...) < 0`)
  now escalates with a fingerprint and `ANSWER` path instead of being
  silently `reported`. The fingerprint folds in the tool/request text, not
  just `{question, options}`, so two distinct unanswerable commands don't
  collapse into one already-escalated episode. **BREAKING CHANGE for
  callers of `createBlockingEscalationWatcher`** — pass the scope your own
  answering pass actually uses.
- The no-stored-rule shape is keyed on dialog SHAPE (a proceed-prompt with
  no stored-rule option), not on warning text, so any sibling
  `too-complex` reason is handled the same way. Answerable with option 1
  (`Yes`) only; no scope ever targets a `/auto mode/i` option (tested).
- Fixtures are real captures (two `too-complex` reasons: brace-with-quote
  "expansion obfuscation" and a zsh `<N-M>` glob), not hand-written.
- Note (established during review, not a code change here): under
  `scope: "once"` — what butchr's permission-answer loop actually passes
  — this dialog shape was already answerable before this fix. The
  escalation-gap fix above only fires for a caller on `scope: "always"`.
  This release does not by itself prove any specific previously-reported
  stalled pane is fixed; see FACTORY-146 for that investigation.

## 0.16.1

FACTORY-128 (FACTORY-106): the combined release. Merges drovr main (which
carries 0.15.2 below) into the FACTORY-106 story branch (which carries 0.16.0
below), so this one release contains all three changes that had been split
across two lines: Codex lizard mode (0.16.0's content), the `AskUserQuestion`
dialog-recognition fix, and the bundled approval-sound asset (both from
0.15.2's content). No behaviour from either side is changed by the merge
itself — see the two entries below for what each contributed.

## 0.16.0

FACTORY-107 (FACTORY-106): Codex lizard mode, drovr half. New
`src/codex-permission-approval.ts` (exported from `src/index.ts`), the
Codex-vendor twin of `permission-approval.ts`'s Claude support — for a Codex
session launched WITHOUT `--dangerously-bypass-approvals-and-sandbox`
(`buildAgentStartParams`'s `bypassApprovalsAndSandbox: false`).

- **`classifyCodexApprovalScreen`**: recognises three on-screen shapes,
  measured live on codex-cli 0.145.0 (2026-09-26; fixtures under
  `test/fixtures/codex-approval/`) — `"command"` (a shell command needing
  approval; a network-access escalation renders the IDENTICAL shape, only
  the `Reason:` text differs — Codex has no separate dialog for it),
  `"file-edit"` (an apply_patch edit outside the sandbox), and `"mcp-tool"`
  (an MCP server tool call). See `docs/codex-permission-approval.md` for the
  full wording table. A screen that is approval-shaped (one of the two known
  footers, or a `Would you like to …`/`Field N/M` phrase) but fails to parse
  into one of those three is `{ kind: "unrecognised", excerpt }` — **never**
  silently `undefined` — the same DROVR-41 class of gap the Claude classifier
  already closed, structured out by construction here instead.
- **`onceOptionIndex`**: the plain approve-once option and nothing else —
  `"Yes, proceed"` / `"Allow"` — never a stored-rule, session, or "always"
  variant. There is no `"always"` scope for Codex; approve-once is the only
  behaviour this module offers, by design.
- **`scanPendingCodexApprovals`**: filtered to `agent.agent === "codex"`
  only, mirroring `scanPendingPermissions`'s shape, plus a third bucket
  (`unrecognised`) alongside `pending`/`unreadable`.
- **`approveCodexApproval`** / **`autoAnswerCodexApprovals`**: reuse
  `permission-approval.ts`'s exported `defaultDeps`/`PermissionApprovalDeps`
  and write to the SAME audit file Claude lizard mode does (records carry
  `vendor: "codex"`). An `"unrecognised"` pane is never answered — logged to
  the audit trail (`outcome: "unrecognised"`) and reported back for a human,
  never skipped silently.
- A Codex agent still launched with `--dangerously-bypass-approvals-and-sandbox`
  (today's default) never shows any of these dialogs, so scanning or
  auto-answering it is a harmless no-op — enabling Codex lizard mode is
  entirely a launch-flag decision the host makes (Butchr's FACTORY-108), and
  a non-lizard Codex agent is structurally unaffected by this release.

Additive; no existing export's behaviour changes. `permission-approval.ts`
gains one new export, `defaultDeps`, for the reuse above; its value and
default behaviour are unchanged.

## 0.15.2

Two changes ship together: FACTORY-113's dialog-recognition fix, merged to
`main` after 0.15.1 but not yet released, and FACTORY-100's bundled
approval-sound asset.

- **`describeUnknownDialog` recognises Claude Code's `AskUserQuestion`
  dialog** (`src/blocking-prompts.ts`) correctly in all three shapes — plain,
  a side-by-side preview, and a truncated (`✂ N lines hidden`) preview.
  Before this fix, the side-by-side and truncated-preview layouts made the
  function return `undefined` outright (no fingerprint, no `ANSWER` path);
  the plain layout, by contrast, was already recognised, but its "Chat about
  this" trailer read as a real, numbered option, so the dialog it returned
  silently carried a phantom extra option. Fixing both means
  `classifyBlockingScreen` now reports `kind: "unknown"` with an accurate
  `dialog` populated for all three, and the escalation watcher gets a stable
  fingerprint and `ANSWER` path. Fixes the FACTORY-111 hang. The old footer
  gate required pure-blank lines between the last option and the footer;
  every `AskUserQuestion` dialog — plain included — draws a "Chat about
  this" meta-action past a full-width separator (and, with a preview, a
  `Notes: press n to add notes` line) that violated it, so this was never a
  preview-only bug. Fixtures are real captures against a live Claude Code
  pane (2.1.251). See
  [`docs/blocking-escalation.md`](blocking-escalation.md) for the full
  measured writeup. (FACTORY-113/FACTORY-114)
- **Bundles `assets/sounds/lizard-button.mp3`** (30,940 bytes) in the
  published package, and adds `assets` to package.json `files`. This is the
  default sound for lizard mode's optional, off-by-default approval sound
  (FACTORY-100): the host application (`butchr`) plays it when that option
  is on and an auto-answer approves a prompt. **drovr never plays this file
  itself** — see the README's new "Bundled assets" section for how a
  consumer locates it (`exports` still exposes only `"."`) and where the
  file came from. The original `myinstants.com` URL returns a Cloudflare 403
  to non-browser clients on this factory's hosts, which is why the file is
  bundled rather than fetched at runtime.

## 0.15.1

FACTORY-93: `autoAnswerPermissions` gains an optional `scope`
(`"always"` default — unchanged; `"once"` new). With `"once"` an unattended
pass presses option 1 only when it is exactly `Yes`, instead of hunting for
the "Yes, and …" stored-rule option. The "always" matcher never recognised
Claude's read-permission dialog ("Yes, allow reading from … from this
project") and silently skipped it, freezing a lizard-mode agent on its first
out-of-workspace read (seen live on codey, 2026-09-26). `"once"` is
wording-independent and stores no rules. Additive; existing callers are
unaffected.

## 0.15.0

FACTORY-46 (FACTORY-44): any blocking dialog is Drovr's job to detect and
handle, not a host's — hosts must not keep their own dialog lists. This
release adds the general, host-neutral mechanism for everything Drovr does
not recognise, plus a speculative, unconfirmed matcher for the wording
FACTORY-44 described.

- **`classifyStartupPrompt` gains a SPECULATIVE matcher for the
  "fullscreen renderer didn't finish starting last time" wording**
  (`src/resident-host.ts`), a new `StartupPrompt` kind
  `"fullscreen-renderer"`, answered `Not now` if a screen ever shows one.
  **This is not a confirmed fix for a real dialog.** No fixture, log, or
  live capture of an interactive dialog carrying this wording exists
  anywhere in this checkout — only the ticket's own prose. Worse:
  `strings` run directly against the installed `claude` 2.1.283 binary
  shows this exact phrase only inside a NON-INTERACTIVE NOTICE, with no
  options and no footer — a screen carrying it is not something this (or
  any) matcher could press a key on. As written, this branch most likely
  never fires on the real string at all; it is kept only as a conservative
  fallback in case some other, genuinely interactive variant exists that
  this checkout has not seen — that is unconfirmed. See
  [`docs/blocking-escalation.md`](blocking-escalation.md) for the full
  evidence and the version checked. It is deliberately distinct from the
  separate, already-recognised "Try the new fullscreen renderer?" opt-in
  offer (interactive, and unaffected by any of the above).
- **`BlockingPrompt` (`src/blocking-prompts.ts`) gains two additive,
  optional fields**: `keys` (present for a `startup` prompt Drovr can press
  itself — trust, development-channels, auto-mode-onboarding,
  fullscreen-renderer; absent for `mcp-approval`, which stays reported-only)
  and `dialog: { question, options }` (present for an `unknown` prompt only
  when its shape can be read with confidence). Existing consumers reading
  only `kind`/`name`/`excerpt` are unaffected.
- **`describeUnknownDialog`** (`src/blocking-prompts.ts`, exported): the
  question and verbatim options of any dialog waiting on Drovr's existing
  `WAITING_FOOTER`, adapted from `brooswit-factory/butchr`'s
  `src/agents/prompt.ts` `parsePrompt` — which had already, independently,
  closed a self-sustaining escalation loop (that repo's KAN-756): a pane
  merely narrating or quoting a past dialog, including one already
  escalated and quoted back from a ticket comment, must never itself read
  as a live menu. Same two structural gates carried over: the footer must
  be the very next thing after the last option, and an unnumbered menu must
  carry exactly one visible cursor. Undefined — never a guessed payload —
  when the shape can't be read with confidence.
- **`createBlockingEscalationWatcher`** (new `src/blocking-escalation.ts`):
  the host-neutral escalation hook. One `watcher.poll(client)` call per
  fleet poll presses the keys for every known-safe startup prompt, leaves
  `mcp-approval` and tool-`permission` prompts reported (their existing
  flows are unchanged), and for a genuinely unrecognised dialog calls
  `hook.onUnknownDialog` with pane/session identity (`cwd` doubles as
  identity for a pane with no issue key), the question and options
  verbatim, and a content-based `fingerprint` — exactly once per
  `(pane, fingerprint)` episode, tracked in the watcher's own closure, never
  in Drovr's exports or in a host's ticket system. `hook.onDialogResolved`
  fires once that episode's dialog is no longer on screen with the same
  fingerprint; a pane that goes `unreadable` mid-episode is left open, not
  resolved on a guess. A hook rejection is caught per-pane
  (`AutoHandleOutcome`'s `hook-failed`) and never fails the rest of a poll.
  Drovr ships no consumer of this hook itself — see
  [`docs/blocking-escalation.md`](blocking-escalation.md).

## 0.14.0

BUTCHR-417: `InboxRelay.push()` race fix — a message pushed as the previous
`drain()` loop finishes could be silently dropped forever.

- **`InboxRelay` fix**: `push()` used to clear its internal `draining` flag
  via `.finally()` chained onto the promise `drain()` returns. `drain()`'s
  own while-loop exiting and that `.finally()` callback actually running are
  two separate microtask turns; a `push()` landing in that gap saw `draining`
  still truthy, skipped starting a new drain, and its message sat queued
  forever with nothing left running to ever deliver it — deterministically,
  not just under pathological timing, whenever a second message arrived
  right as the first one finished draining. `draining` is now cleared inside
  `drain()`'s own `try/finally`, as part of its synchronous continuation when
  the loop exits, closing the gap. Found by BUTCHR-413 building the Codex
  channel relay in butchr.

BUTCHR-453: `strictMcpConfig` for a Claude launch — the Candlestix directors
need "permission mode auto with a strict MCP config" to migrate to
butchr-managed sessions faithfully, and Drovr had no way to ask Claude Code
for one.

- **`ClaudeAgentLaunch.strictMcpConfig`/`ProviderLaunchInputs.strictMcpConfig`**
  (`boolean`, optional): `true` emits `--strict-mcp-config` immediately after
  `--mcp-config` in `buildProviderLaunchArgs`/`buildAgentStartParams`, so
  Claude Code loads ONLY the MCP servers named in that file — no
  project-level or user-level `.mcp.json` discovery. Codex and AGY accept the
  field and spell nothing. `checkManagedAgentArgv` treats it as a required,
  presence-only flag (no value to compare) when the expected launch sets it,
  same discipline as `--dangerously-bypass-approvals-and-sandbox`. Absent or
  `false`: no flag, today's behaviour exactly.

## 0.13.0

DROVR-24 and DROVR-33, both fleet-scan/auto-answer hardening so a failure
under unattended use is loud, never silent.

DROVR-33: a pane scan no longer turns "couldn't check" into "fine". Found by
lead-bakr and lead-factory-dashboard reviewing bakr #42 (`bakr status
--json`, BAKR-48) — their `status.v1` contract requires "couldn't check" to
be `null`, never "down" and never "fine".

- **`scanBlockingPrompts(client, { readTimeoutMs? })`** and
  **`scanPendingPermissions(client, { readTimeoutMs? })`**: each returns
  `{ prompts | pending, unreadable }`, where `unreadable` is every Claude
  pane whose screen could not be read — `agent.read` rejected (`reason:
  "error"`) or never settled within `readTimeoutMs` (`reason: "timeout"`,
  default 1500ms). Previously a failed `agent.read` gave `screen = undefined`
  and the pane was silently skipped (`listBlockingPrompts`), and
  `readScreen(...).catch(() => "")` made an unreadable pane read as "no
  pending prompt" (`listPendingPermissions`) — in both cases a caller could
  not tell "not blocked" from "could not check". Reads run in parallel, so a
  scan takes roughly the slowest read, capped by the deadline — not the sum
  of every pane's read, and never unbounded, which is what let a hung
  `herdr agent read` hold an entire scan open until the *caller's* own
  timeout (bakr passes 15s) before this fix.
- **`listBlockingPrompts` and `listPendingPermissions` are now thin wrappers**
  over the two `scan*` functions above: same signature, same behaviour,
  `unreadable` dropped. Every existing caller is unaffected.
- A failure of `agent.list()` itself still rejects; the caller maps that to
  "couldn't check anything", not an empty result.
- `autoAnswerPermissions` still scans with `listPendingPermissions`, not
  `scanPendingPermissions` — its own scan step still silently drops an
  unreadable pane rather than reporting it `failed`. Left to the caller; see
  `docs/permission-approval.md`.
- New exports: `scanBlockingPrompts`, `scanPendingPermissions`,
  `UnreadablePane`, `PaneReadDeadlineOptions`, `ScanBlockingPromptsOptions`,
  `ScanPendingPermissionsOptions` (`src/pane-scan.ts`). See
  `docs/permission-approval.md`.

DROVR-24: a throw after the `approving` audit line used to escape
`approvePermission` entirely, stranding that record with no outcome.

- **`approvePermission` no longer lets a post-`approving` throw escape.** A
  rejecting `sendKeys` now returns `{ ok: false, reason: "keys-failed",
  detail }`, whose detail says whether a key may have reached the pane is
  unknown. A throw inside the verify loop (`deps.now`/`deps.wait`) returns
  the same shape under the distinct `reason: "verify-failed"`, since by then
  `sendKeys` already resolved. Both make a best-effort outcome `appendAudit`
  for the same `attemptId` before returning; a failure to write that record
  is itself swallowed, so it can never mask the result. Keys are never
  retried. Both new `ApprovePermissionRefusalReason` values map to
  `autoAnswerPermissions`'s `failed` outcome, alongside `not-cleared` and
  `audit-failed` — treat them as a failure, not a refusal. See
  `docs/permission-approval.md`.

## 0.12.1

DROVR-41: live proof of `autoAnswerPermissions` against a real herdr pane
(both the answer and the skip path), and a classifier fix it found along the
way.

- **`classifyPermissionPrompt` fix**: an option long enough to wrap onto a
  second physical line with no number of its own used to end the option
  scan early, so the whole dialog read as "not a prompt" — invisible to
  `listPendingPermissions`/`autoAnswerPermissions`, not merely unanswered.
  Measured live on claude 2.1.251: a Bash-tool "don't ask again for … commands
  in …" option wrapped this way went unrecognised entirely. A wrapped
  continuation line is now folded back into the option it continues; a blank
  line, the "Esc to cancel" footer, or a fresh separator/question still ends
  the scan. See `docs/permission-approval.md`.

## 0.12.0

Brooswit's top Drovr priority (DROVR-37): no agent should sit frozen on
Claude's tool-permission dialog waiting for a human. `autoAnswerPermissions`
is the first unattended pass. Its live proof on a real pane and the host
wiring are still to come (DROVR-40); this release is the library function.

- **`autoAnswerPermissions(client, { auditPath, operator = "drovr-auto",
  readTimeoutMs? })`**: scans every pane with `listPendingPermissions` and
  presses only the `scope: "always"` option, which is option 2 in the
  measured dialog — the prompt's own `options` are checked before
  `approvePermission` is ever called, so a dialog whose option 2 isn't the
  "Yes, and …" stored-rule option is `skipped` with nothing pressed and no
  `approving` audit record. Answers are audited under `drovr-auto` by
  default, distinct from a human operator's name. One pane throwing, or (with
  `readTimeoutMs` set) missing its deadline, is `failed` for that pane alone
  and never stops the rest. `readTimeoutMs` bounds the whole approve attempt
  but does not cancel it, so a `timeout` result means the outcome is unknown
  (check the audit log), not "nothing pressed". See
  `docs/permission-approval.md` for the full result-mapping table.
- DROVR-24 and DROVR-33 sit under this pass but are deliberately not fixed
  here (see `docs/permission-approval.md`); `autoAnswerPermissions` only
  guarantees that a throwing or hung **approve** attempt can't take the whole
  pass down with it.

## 0.11.1

Codex usage limits are recognised, so a Codex worker at its limit is replaced
instead of sitting idle forever. Codex had run out (reset 29 Sep 16:03) and
switched itself to its Luna Reserve model; Herdr reported the panes idle, and
nothing in Drovr could say they were refused.

- **`classifyCodexUsageLimitText(text, now)`**: the Codex counterpart of
  `classifySessionLimitText`. It anchors on Codex's own `• Automatically
  switched to <model> due to usage limits.` and `■ You’ve hit your usage
  limit` at column 0, takes only the most recent notice, treats `switched
  back … ordinary usage is available again` as recovery, and suppresses a
  notice the agent has carried on past. Tested on the two live pane reads.
  `parseCodexUsageReset` reads `16:03 on 29 Sep` and `try again at …` in local
  time, and returns null rather than guess.
- **`ProviderAvailabilityRegistry.observePane(account, status, text)`**
  routes to the account's provider classifier (`classifyProviderQuotaText`)
  behind the same idle/done gate. `observeClaudePane` is kept.
- **`ManagedHerdrLifecycle`** checks a Codex kickoff for the usage-limit
  notice, as it already did for Claude, and moves on to the next provider.
- **`ManagedConversationRunner`**: a Codex `exec --json` turn that failed on
  the usage-limit message throws `ManagedConversationQuotaError` with
  `provider: "codex"`, so `ManagedConversationLifecycle` falls through.
  `codexTurnErrorQuota` gives App Server runners the same check, including
  `codexErrorInfo: "usageLimitExceeded"`.
- Replacement already re-walks priority from the top; this is now tested for
  codex→claude, claude→codex and a reset that passes.

Release asset: `brooswit-drovr-0.11.1.tgz`.

## 0.11.0

The first vendor-agnostic slice: an agy agent (usrr's) gets its MCP servers and
live Rocket.Chat messages, the way a Claude agent already does.

- **agy gets its MCP servers, not only permission to use them.** An
  `McpServerAccess` can carry a `definition`, parsed from a `.mcp.json` by
  `mcpServersFromMcpJson`. For agy, `applyMcpAccess` writes each defined
  server into `<home>/.gemini/config/mcp_config.json` in agy's own format,
  measured with `agy mcp add` on 1.2.6: `{serverUrl, headers, disabled}` for
  http and `{command, args, env, disabled}` for stdio. Servers it doesn't name
  and other keys are kept. A server it names is replaced whole: the
  declaration is authoritative for it. A `type` other than http or stdio
  (e.g. `sse`) is refused at parse time. Servers dropped from a declaration
  are not removed yet.
- **Inbox relay for vendors without live channels.**
  - `connectChannelSource` / `keepChannelSource` connect to a thatch server
    (rocketr) as an MCP client and receive every `notifications/claude/channel`
    frame. `keepChannelSource` reconnects with capped backoff on close,
    transport error or failed connect.
  - `InboxRelay` delivers one message at a time, in order. A busy answer is
    retried; a message is dropped, and reported, when the host rejects it,
    after `maxAttempts` failures, or past `maxQueue`. Delivery is
    at-least-once, and the queue lives in memory.
  - `usrrDeliver` posts each message to usrr's `/v1/message` socket API, where
    `accepted` is the delivery proof.
  - `renderInboxTurn` neutralises any `<channel` / `</channel` in the body, so a
    sender can't close the frame early, and puts the external-data notice
    first.
  - Proven live: a real rocketr mention was received and rendered as a
    `<channel>` turn.
  - New dependency: `@modelcontextprotocol/sdk` ^1.30.0, the same version
    thatch and rocketr use.

Release asset: `brooswit-drovr-0.11.0.tgz`.

## 0.10.3

- `hostResident` reports a resident ready only when herdr names its session,
  or, for a session herdr never names, after three clean ready reads in a row.
  Found by bakr on lead-dynamic-atmosphere's move: herdr called the pane
  `interactive_ready` and idle before claude drew the development-channels
  warning, so a single clean read returned too early and left the warning up.
  The same rule as bakr #36.

Release asset: `brooswit-drovr-0.10.3.tgz`.

## 0.10.2

- `listBlockingPrompts` and `classifyBlockingScreen`: every dialog a Claude
  pane is waiting on, read from its screen whatever herdr reports, tagged
  `startup`, `permission` or `unknown` with pane, label, session and excerpt,
  so a host can answer what Drovr knows and alert a person on the rest. A
  dialog counts only when its waiting footer is on screen. Its first live
  read-only run found three panes on the auto-mode menu that herdr reported
  idle or done.
- Finish the auto-mode setup on an account that already has entries: "You
  already have auto-mode entries" gets "Add to them" (never "Start fresh",
  which would replace them), and the review of the generated environment gets
  "Looks good — save it", so each agent's view adds to the account's. Both
  measured on yappr-3's pane, 2026-09-18; the save was the manager's decision
  under Brooswit's "always Yes".

Release asset: `brooswit-drovr-0.10.2.tgz`.

## 0.10.1

- Answer Claude Code's "Teach auto mode about your environment?" menu the way
  Brooswit chose: "Yes", then on the setup screen tick both "Also scan shell
  history" and "Also scan your other repos" (usage left as shown), then
  Continue. One step per screen read, so Continue is pressed only once the
  screen shows both boxes ticked. Space as the toggle key is not yet observed
  live; if it does not tick a box, Continue is never pressed and the launch
  ends `not-ready` with the excerpt. Measured on lead-factory-dashboard's and
  nexus-admin's panes, 2026-09-18. Claude shows this menu only while
  `autoMode.environment` in `~/.claude/settings.json` is empty, so once the
  setup has run for an account it does not appear again.
- Read a menu's own cursor: the `❯` nearest above its "Enter to confirm"
  footer. A live or resumed pane also shows transcript prompts above a menu
  and its input box below it, and taking the first `❯` on screen would have
  closed a resumed trust dialog as `unknown-blocking`.

Release asset: `brooswit-drovr-0.10.1.tgz`.

## 0.10.0

- Host residents in herdr panes: `hostResident`, `listResidents` and
  `stopResident` (see `docs/resident-host.md`). The label is the herdr agent
  name and is checked free before anything is created: on 2026-09-18 bakr
  started every pane as `claude`, and seven agents lost their panes to the
  name collision. Startup prompts are answered from the menu drawn on screen,
  and the first turn is sent once the input box is ready. Proven live against
  an isolated herdr session, including a resume of the same session.
- Confirm delivery of a long message. Claude Code records a long bracketed
  paste as `<pasted_content id="…">…</pasted_content id="…">` instead of the
  pasted text, so every long send reported `delivery-unconfirmed` although it
  had landed (measured on rocketr's resident, session 517fd13a). The messenger
  now also accepts exactly one such block wrapping the sent text, and nothing
  else in the record.
- Approve a pending tool-permission prompt without a terminal:
  `listPendingPermissions` and `approvePermission` (see
  `docs/permission-approval.md`). The prompt is re-read and refused if it
  changed since the operator saw it, an audit record is written before any
  key is sent, the auto-mode option is never chosen, and success means the
  prompt left the screen. Proven live on a real Bash prompt.
- Reach a resident that is busy only with background workers. Claude lists a
  session `busy` for as long as a Monitor runs, so every agent with a watcher
  refused every send. `claudeResidentActivity` reads the transcript: a session
  whose last conversation record closed its turn is `background` and takes the
  message; one still mid-turn is refused as `busy`, as before. Only Claude's own
  `busy` can become `background`: a session listed `blocked` (stopped on a
  dialog) is refused as `blocked`, and any other status as `busy`.
- `listResidents` reports each resident's provider `pid` (the pane's foreground
  process named after the provider, never the shell), for a host's own
  liveness check.

Release asset: `brooswit-drovr-0.10.0.tgz`.

## 0.9.2

- Join each Claude channel to its flag. With more than one channel,
  `--dangerously-load-development-channels server:yappr server:rocketr` let
  `claude --bg` take the second value as the session's first prompt, even
  before `--bg`. Measured on claude 2.1.276: the session began with the
  literal turn "server:rocketr", never registered the channel, and
  Rocket.Chat DMs pushed to it were dropped. `buildProviderLaunchArgs` now
  emits one `--dangerously-load-development-channels=server:x` per channel.
  `checkManagedAgentArgv` reads both spellings, so a process launched by an
  older build is not reported as drifted.

Release asset: `brooswit-drovr-0.9.2.tgz`.

## 0.9.1

- Send to a never-prompted resident. A fresh background session lists with no
  `status` at all. The messenger read that as busy and refused every send
  (measured on factory-dashboard's resident for 6+ minutes). An absent status
  is now checked against the session's screen: the session counts as idle
  unless the screen shows a blocking prompt. A blocking prompt is refused with
  the new `blocked` reason, rather than answered by a typed Enter.
- Find a resident's transcript by session ID. When a session enters a git
  worktree, Claude moves its whole transcript to the worktree's project
  folder. Reads by launch directory then failed with "saved history is
  unavailable" after a delivery that had succeeded, and `deliverToResident`
  saw nothing. `readClaudeTranscriptTail` now finds the file wherever it is,
  and the messenger finds the session by its UUID at its current listed cwd.

Release asset: `brooswit-drovr-0.9.1.tgz`.

## 0.9.0

- Add `launchBackgroundSession`, so a host starts a Claude background session
  through Drovr and gets back a clean `shortId` and the listed `sessionId`
  instead of parsing `claude --bg` output itself. Options always precede
  `--bg`, output is read without `FORCE_COLOR` and with escapes stripped, and
  the id is confirmed against `claude agents --json`. See
  [background launch](background-launch.md).
- Add `BlockingCondition` for host-wide provider conditions, each measured:
  `login-expired`, `daemon-binary-replaced`, and `mcp-approval-prompt`.
  `launchBackgroundSession` refuses before launching when the daemon runs a
  deleted executable. It reports a session stuck on a prompt as `blocked`
  and returns the session's id so the caller can clean it up.
- Add `startClaudeLogin` for headless re-authentication. The authorize URL
  is relayed out and the pasted code relayed back into the same PTY, and the
  result is proven by `claude auth status`.
- Add `mcpServersApproved` to `ProviderLaunchInputs`. For Claude it becomes
  `--settings {"enabledMcpjsonServers": …}`, which holds in an untrusted
  directory where a workspace `settings.local.json` approval is ignored.
- `runConversationProcess` no longer passes `FORCE_COLOR` to the CLI it parses.
- Accept AGY 1.2.5's own full transcripts, which 0.6.0 rejected as "incomplete
  or has an unsupported record" and so broke USRR history and provider
  handoff. Measured on this host's transcripts, AGY writes records in
  completion order, reuses an interrupted turn's step index, never writes
  some steps, and omits `content` on tool-only planner steps. 14 of 21 were
  rejected before this change and all 21 are accepted after it. Completeness
  now rests on AGY's own signals: a partial final record, or
  `truncated_fields`. `nativeTranscriptReply` takes AGY's reply from the
  highest step instead of the last line.

- Drovr owns MCP access across vendors: one `McpAccessDeclaration` renders into
  Claude's `enabledMcpjsonServers`, AGY's `permissions.allow: ["mcp(<server>/*)"]`
  and Codex's start arguments. `setMcpAccess` provisions then restarts, because
  every vendor reads this at process start; `switchProviderMcpAccess` provisions
  the target before its first process starts; both gate readiness on
  `awaitIdentityRelease`, a real check with a deadline, never a sleep. See
  [MCP access](mcp-access.md).
- Report subscription as its own launch-time act: `restart: "fresh-launch"`
  when a running process lacks a declared channel, since a respawn carries no
  arguments and can never apply one, and `subscriptionUnverified` when the
  caller has not said what the process was launched with. `notificationSupport`
  states the ceiling — AGY and Codex are the wrong runtime, headless Claude has
  no acceptor, and even a supported session needs a human to accept each frame.
- Refuse an AGY turn that answers `SUCCESS` with an empty response and a
  populated `denied_actions` (`AgyDeniedActionsError`), instead of persisting a
  denied turn as an assistant turn that said nothing.
- Add `deliverToResident`, which refuses to read a notification channel's
  transport acknowledgement as delivery to a resident. A stream-level ack is
  confirmed against the resident's own transcript and, when the message never
  appears, the resident is woken through the proven attach transport. Fixes
  reports acknowledged as delivered that an idle session never received.

Release asset: `brooswit-drovr-0.9.0.tgz`.

## 0.8.0 (never published)

Built and shipped by hand to servyboi; everything below first shipped in a
published release as 0.9.0.

- Own configurable MCP servers and development channels at the Drovr boundary.
  `mcpConfigPath` and `developmentChannels` are provider-neutral launch inputs
  accepted for Claude, Codex, and AGY, and `ManagedHerdrStartRequest` accepts
  both so a caller states them once per request. Claude receives `--mcp-config`
  and `--dangerously-load-development-channels`; other providers take the same
  inputs without Claude-specific coupling.
- Merge development channels instead of replacing them, so a request that adds
  one channel keeps the channels its launch already configures. Duplicates
  collapse, first-mention order is kept, and `mergeDevelopmentChannels` is
  exported for callers combining lists themselves. `checkManagedAgentArgv` now
  checks every configured channel against a live process rather than the first.
- Add `buildProviderLaunchArgs` for callers that spawn a provider CLI directly
  instead of going through Herdr, so Claude's flags stay inside Drovr. Neutral
  `ProviderLaunchInputs` name an MCP config path, the MCP servers whose
  notifications a session needs, and any already-spelled channels; Drovr maps
  each notifying server to `server:<name>` for Claude and to nothing for Codex
  and AGY. `ManagedAgentLaunch` and `ManagedHerdrStartRequest` accept
  `mcpNotificationServers` on the same terms, and the Herdr adapter now builds
  its Claude arguments through the same function.

## 0.7.0

- Add provider-neutral `createResidentAgentMessenger` for sending one message to a
  running resident and reading its reply. Claude sends through `claude attach` in a
  PTY and proves delivery and reply from that session's own transcript. It never
  resumes or forks. Codex and AGY refuse with `unsupported-provider`.
- Add `readClaudeTranscriptTail` for incremental reads of live Claude transcripts.
  A session that has never been prompted has no transcript yet; reading it from
  offset 0 returns empty text, so a freshly created resident can take its first
  message.

See [resident agent messaging](resident-agent.md).
Release asset: `brooswit-drovr-0.7.0.tgz`.

## 0.4.0

- Add `ManagedConversationRunner` for direct AGY, Codex, and Claude CLI messages
  and native conversation resume, with an injectable `RunProcess` adapter and
  interactive `attachArgv`. This API is separate from Herdr-managed workers.
- Preserve USRR's AGY permission and JSON argument behavior; map Codex JSONL and
  Claude JSON results to `{ conversationId, response }`. Reject incomplete turns,
  failed results, and changed resume IDs without exposing process diagnostics.
- Leave provider selection, saved provider/ID pairs, and known account availability
  to consumers. No quota classification or cross-provider resume is added.
- Export `startManagedAgent` and `AgentShellReadinessError` for bounded retries
  of Herdr's explicit pre-launch `agent_pane_busy` refusal, with sanitized
  readiness diagnostics. Other launch failures propagate unchanged.

See [conversation runtime](managed-conversation.md) for API and verification limits.
Release asset: `brooswit-drovr-0.4.0.tgz`.

## 0.3.2

- Add `prepareManagedAgentWorkspace({ provider, cwd, unattended }, settingsPath?)`.
  For unattended AGY launches, trust the exact existing realpath directory in
  `~/.gemini/antigravity-cli/settings.json`. Root, home, and ancestors of home
  are refused. Other providers and attended launches are no-ops.
- Preserve other settings and trust entries, reject malformed settings without
  overwriting them, serialize calls within the process, and replace settings
  atomically using a private temporary file. Tests use isolated fixture settings.
- Keep workspace preparation separate from `buildAgentStartParams`:
  `--dangerously-skip-permissions` does not dismiss AGY's workspace trust screen,
  and trusting a parent directory does not trust its children.

Release asset: `brooswit-drovr-0.3.2.tgz`.

## 0.3.1

- Add `AgyAgentLaunch.skipPermissions?: boolean` and export the launch type from
  the package entry point. Explicit `true` adds `--dangerously-skip-permissions`
  to AGY launch arguments; omitted or false preserves the existing behavior.
- Clarify that AGY inherits cwd from its pane and uses external MCP configuration,
  including stdio-to-HTTP bridges. No cwd, MCP, or workspace-trust flags are added.

Release asset: `brooswit-drovr-0.3.1.tgz`. Consumers must update their dependency
URL and lockfile after the matching `v0.3.1` GitHub release is published.
