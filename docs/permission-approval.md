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

### The "too-complex" shape: no stored-rule option at all (FACTORY-146/FACTORY-318)

Claude's static bash analyser marks some commands `{kind: "too-complex"}` —
a family of reasons (a brace containing a quote character, a zsh `<N-M>`
numeric-range glob, a lone surrogate, control characters, Unicode
whitespace, backslash-escaped whitespace, a zsh `=cmd` expansion, a parser
timeout, and more) sharing one consequence: no permission rule can be
derived from a `too-complex` command, so Claude never builds the `"Yes, and
don't ask again for: …"` option for it at all. The dialog still classifies
as `permission` — recognition depends only on the three preconditions above
(a `❯` cursor, a plain `─{10,}` separator OR the newer no-separator chrome
below, an `Esc to cancel` footer within 3 lines), none of which this shape
touches — but it collapses to exactly three options:

```
─────────────────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below

   echo {'a','b'}
   Echo brace expansion

 Contains brace with quote character (expansion obfuscation)

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and switch to auto mode · auto mode handles these prompts for you
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
```

Real capture, `claude 2.1.251`, `claude --permission-mode default` in an
isolated scratch directory, 2026-09-26 — committed at
`test/fixtures/too-complex-permission/brace-with-quote.txt`, alongside a
second real capture of a different `too-complex` reason
(`zsh-numeric-range-glob.txt`, "Contains zsh `<N-M>` numeric-range glob")
proving the fix is keyed on the dialog's SHAPE, not the warning's wording.

**`optionFor(prompt, "once")` answers this shape** (plain `"Yes"` sits at
index 0 on every dialog this family produces) — that is the scope butchr's
permission-answer loop passes (FACTORY-93). **`optionFor(prompt, "always")`
finds nothing** (there is no `"Yes, and …"` stored-rule option to find,
never mind the auto-mode one, which is excluded from both scopes exactly as
it already was for every other dialog) — `autoAnswerPermissions`'s own
default scope when a caller doesn't request `"once"`. `optionFor` is
exported specifically so a caller other than `approvePermission` (namely
`createBlockingEscalationWatcher`, see `docs/blocking-escalation.md`'s "The
no-stored-rule shape" section) can ask "would MY scope answer this prompt?"
without pressing anything or re-implementing the rule.

### Two more measured shapes: the generic MCP-tool dialog and WebFetch (FACTORY-356/365/6)

The four-option Bash dialog above is not THE shape — it's the first one
measured. Two more real shapes each fail exactly one of the five
preconditions (question, cursor, `options[0] === "Yes"`, a `No` option,
`Esc to cancel` footer, `─{10,}` separator), a different one each, and each
is recognised by a narrow fallback specific to what its own real captures
justify — never by loosening the general rule for every shape.

**Generic MCP-tool dialog — no `─` rule anywhere on screen.** Measured on
`claude 2.1.251`, `claude --permission-mode default --restricted` in an
isolated scratch pane, 2026-09-27 (a butchr MCP tool, `tell_worker`, called
with a long enough `text` parameter that the tool-call header and the rule
above it scrolled off the pane's *visible* screen — the same `source:
"visible"` read `readScreen` uses, so this is the shape a real blocked pane
shows once its displayed request is long enough, not one specific to Tell
Worker):

```
   About the butchr — Tell Worker Tool:
   │ The ONLY way to speak DOWN to a worker: comments on ONE OF THE CALLER'S OWN workers'
   │ ticket. Refuses a `key` that is not one of the caller's own workers, verified via the…
   (ctrl+o to expand description)

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for butchr — Tell Worker commands in /tmp/claude-1002/…
   3. No

 Esc to cancel · Tab to amend
```

There is no `─{10,}` line anywhere on this screen at all — the dialog frames
its body instead with an `About the <server> — <Tool> Tool:` header and a
`(ctrl+o to expand description)` line. When no separator is found,
`classifyPermissionPrompt` now falls back to that frame: it looks for
`(ctrl+o to expand description)` directly (blank lines only) above the
question, then for `About the (.+):` directly above THAT in an unbroken run
of non-blank lines. Both must be found this way, or the fallback does not
fire — a screen that merely mentions the expand hint in ordinary narration,
with no real frame header immediately above it, still classifies as
`undefined` (see `test/fixtures/quoted-permission/synthetic-mcp-tool-narrated-not-framed.txt`).
Committed at `test/fixtures/generic-mcp-tool-permission/pane-tell-worker-cropped.txt`.

A second, ordinary real capture — same tool call, short enough parameters
that nothing scrolls — is committed at
`test/fixtures/generic-mcp-tool-permission/pane-tell-worker-header-visible.txt`.
This one DOES draw a `─` rule (it's the "Tool use" frame, same as Web
Search's), so it is recognised via the EXISTING general path, not this
fallback — `tool` comes out `"Tool use"`, not `"butchr — Tell Worker Tool"`.
Committed alongside the scrolled-off variant so the common case has its own
regression coverage, not just the rarer one.

**WebFetch — no `Esc to cancel` footer at all.** Measured on `claude
2.1.251`, `claude --permission-mode default` in an isolated scratch pane,
prompted "Use the WebFetch tool on https://example.com and tell me the page
title. Nothing else.", 2026-09-27 (also checked against a 60-line
`--source recent` read to rule out viewport truncation — no footer line
exists there either):

```
──────────────────────────────────────────────────────────────────────────────────────────────
 Fetch

   url: https://example.com/
   prompt: What is the page title?
   Claude wants to fetch content from example.com

 Do you want to allow Claude to fetch this content?
 ❯ 1. Yes
   2. Yes, and don't ask again for example.com
   3. No, and tell Claude what to do differently (esc)
```

This one HAS the rule; what it lacks is the footer. The escape hint lives
inline in option 3's own text as `(esc)` instead of a separate `Esc to
cancel` line. `classifyPermissionPrompt` now also accepts a `No, …` option
ending in `(esc)` as satisfying the footer requirement — but ONLY when the
dialog's own body also carries "Claude wants to fetch content from …"
verbatim. That second condition is load-bearing, not cosmetic: without it,
a BARE quoted option list — this dialog's question and options reproduced
in narration, without the framed request body around them — would be
wrongly recognised as live, since the inline `(esc)` hint alone is just
verbatim option text.

An earlier version of this fix anchored the second condition to screen
POSITION instead ("the option list must be the last thing on screen") — that
broke on an ordinary real-fleet event: a butchr notification line landing
on a still-live WebFetch pane AFTER the dialog appeared (two of this PR's
own real MCP-tool captures have exactly this kind of trailing `← butchr:
[…]` line below their dialog too), and it violated the "never key on screen
position" rule this fix is supposed to follow for the same reason the
MCP-tool fallback above does. Anchoring to the dialog's own body content
instead survives trailing chatter, because nothing about the dialog's body
changes when something is appended after it. Both properties are covered by
regression tests in `test/permission-approval.test.ts`: "a bare quoted
WebFetch option list, without the dialog's own body, is not recognised" and
"still recognised with a butchr notification line landing on the pane AFTER
the dialog." A FULL byte-for-byte quote of the dialog, body included, is
NOT something this anchor (or the SEPARATOR-based general path, for any
other shape) can distinguish from a live screen — that limitation is the
same pre-existing baseline every shape already accepts, not a new hole this
fix opens.

The same footer gap exists in `classifyBlockingScreen`'s `WAITING_FOOTER`
(`src/blocking-prompts.ts`): before this fix it matched nothing on this
screen at all, so a WebFetch-blocked pane was invisible to the escalation
scan as well as to the permission scan (worse than the MCP-tool shape
above, which at least read as `"unknown"`) — `WAITING_FOOTER` now also
matches a `No …(esc)` option. Committed at
`test/fixtures/webfetch-permission/pane-fetch-example-com.txt`.

**`separator` is load-bearing twice in `classifyPermissionPrompt`** — it is
both a recognition gate AND the delimiter `tool`/`request` are sliced from
(for the general path), and `promptId` is a hash of `[tool, request,
question, options]`. A fix touching this function without care could make
`promptId` drift as unrelated scrollback shifts. Both fixes above are
proven NOT to have this problem, directly rather than assumed:
`test/permission-approval.test.ts`'s "promptId, tool and request are stable
across differing preceding scrollback" tests (one per shape) prepend 3, 9
and 20 chatter lines to each real capture and assert `promptId`, `tool` and
`request` all come out byte-identical regardless.

**Web Search is the positive control, unaffected.** It has both the rule and
the footer and was already recognised; a regression-guard test pins it at
`test/fixtures/websearch-permission/pane-web-search-example-domain-rfc.txt`.

Both relaxations exist to widen recognition of a genuinely LIVE dialog, not
to recognise one merely quoted in scrollback — a finished prompt scrolled up
the transcript, or text pasted into a ticket description (this exact ticket
quotes both shapes verbatim, which is precisely the risk). A real capture of
an already-answered MCP-tool dialog (`quoted-permission/pane-mcp-tool-already-answered.txt`)
classifies as `undefined`, because Claude Code clears the dialog itself once
answered — there is no "Do you want to proceed?" line left on screen at all.

**A real blocked pane's screen also routinely carries butchr's own
notification lines and a `▔▔▔▔` (U+2594) status-bar rule interleaved in the
SAME frame as the dialog, shifting between reads** (FACTORY-356 comment
26459, relayed via FACTORY-146/FACTORY-327's three-consecutive-capture
finding). Two things this fix deliberately does NOT do, because either would
turn the chatter into a false-positive vector: widen `SEPARATOR`'s character
class to also match `▔` (it stays `─`-only, U+2500), or key recognition on
screen position/line number/distance from the top. The MCP-tool fallback
still keys on the dialog's own frame regardless of what chatter sits above
it — see `test/fixtures/generic-mcp-tool-permission/synthetic-tell-worker-with-notification-chatter.txt`
(dialog still recognised, chatter and `▔▔▔▔` above it, synthetic: composited
from the real chatter line shape in `test/fixtures/session-limit/pane-cap-a.txt`
and the real `▔▔▔▔` rule in `test/resident-host.test.ts` around the real
dialog frame captured above) and `test/fixtures/quoted-permission/synthetic-notification-chatter-no-dialog.txt`
(same chatter and rule, no live dialog at all, still `undefined`).

### A newer chrome with no separator at all (FACTORY-372)

A second, real chrome for the SAME Bash auto-mode-option dialog draws no `─`
rule anywhere on screen. Real capture, attributed to FACTORY-356 (pane
`w29:p1`, `claude 2.1.251`, 2026-09-27, `herdr agent read <pane> --source
visible`, a real frozen `git commit` approval — not a reproduction; handed
over on FACTORY-359 comment 26534/26555, measured against drovr `c6da5fc`
before this fix: `classifyPermissionPrompt` → `undefined`,
`classifyBlockingScreen` → `"unknown"`, zero `─{10,}` matches anywhere on
the screen). Committed at
`test/fixtures/bash-auto-mode-permission/pane-w29p1-4-option.txt`:

```
   │ Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
   │ EOF
   │ )"
   │ git log --oneline -3
   Run shell command

 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for: git commit -m ' *
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend · ctrl+e to explain
```

Two shape details the fix and its tests key on explicitly, not just note:

1. **The title sits BELOW the `│`-prefixed body block**, not above it as on
   the older chrome — `Run shell command`, not `Bash command`. A fix that
   assumed the older ordering would read the wrong line as `tool`.
2. **Option 2's apostrophe is U+2019 (curly `’`), not U+0027 (straight `'`)**
   — `don’t ask again`. A regex matching only the literal `don't` silently
   misses this shape; nothing in `classifyPermissionPrompt` actually keys on
   this text (option parsing is apostrophe-agnostic), but a pinned test
   guards against a future change that might.

**Why this is not simply "drop the separator gate": the separator was doing
two jobs.** It was the recognition precondition being fixed, but it was ALSO
the body delimiter `tool`, `request` (and so `promptId`, which hashes
`[tool, request, question, options]`) are sliced from. Dropping the gate
with no replacement would make `body` start at line 0 of the screen — the
entire visible scrollback — which breaks two things at once: `tool` becomes
whatever the topmost visible line happens to be (not this dialog's actual
title), and `promptId` becomes a function of scrollback, changing on every
poll as unrelated output scrolls (FACTORY-327's "three escalations, three
different fingerprints" — reproduced on demand by FACTORY-356 by prepending
0/3/9/20 synthetic chatter lines to this exact capture and getting four
different promptIds, see FACTORY-359 comment 26578). Since `ANSWER
<n> <fingerprint>` re-checks the fingerprint against the live dialog, a
drifting `promptId` makes escalations for this shape unanswerable — a worse
failure than the original bug, which is at least loud in the journal.

**The replacement delimiter was originally keyed on the fixed line
`This command requires approval`** — but FACTORY-146 (comment 26827 on
FACTORY-359) grepped the installed `claude 2.1.251` binary directly and
found that string, and a `too-complex` command's own security-warning
reason (e.g. `Contains brace with quote character (expansion obfuscation)`),
are both `reason` values the binary renders in the exact SAME slot, as
alternatives, never together — and the string table carries several more
reasons adjacent to both (control characters, Unicode whitespace,
backslash-escaped whitespace, a zsh `~[` dynamic directory, a zsh `=cmd`
expansion, a zsh `<N-M>` glob, a parser abort, a parser skip). **A
too-complex command can therefore never render `This command requires
approval`**, so keying the anchor on that text meant a too-complex command
in this chrome could never be recognised — FACTORY-146's own originally
reported symptom (a security-warning dialog not auto-answered), still
unfixed by the fix that introduced this fallback in the first place.
Enumerating the reason family was ruled out as an option (it is open-ended
and will keep rotting with every Claude Code release); the anchor was moved
onto what's actually invariant instead (FACTORY-385):

1. The body is the contiguous run of `│`-prefixed lines — stopping at the
   first non-`│` line, never scanning further up. This bound is what keeps
   `request`/`promptId` a function of the dialog's own frame and never of
   whatever scrollback sits above it — proven by a test that prepends
   0/3/9/20 lines of synthetic chatter to the real capture and asserts an
   identical `promptId` and `tool` every time. **Kept exactly as before —
   this is not what changed.**
2. The title is the line directly below that `│`-run — found by scanning
   upward from the question through a small bounded gap
   (`MAX_TITLE_GAP_LINES`, currently 3) of non-blank lines, stopping at the
   first one immediately preceded by a `│`-prefixed line.
3. Whatever occupies that gap — `This command requires approval`, a
   too-complex security warning, or nothing at all — is content, never the
   anchor, and nothing here reads its text to recognise the dialog. The bound
   exists so unrelated chatter can't manufacture a title line the screen
   never earned — the same discipline the old "blank lines only" rule
   enforced, just wide enough now to also admit a single reason line.

**FACTORY-391: the gap's content is not discarded, only kept out of the
anchor.** The fix above (FACTORY-385) excluded gap content from `request`
entirely, alongside excluding it from the anchor — losing the
obfuscation/security-warning signal from `approvePermission`'s audit trail
(`shown.request`) for a too-complex command in this chrome, even though the
OLDER separator chrome's own `request` always included that line. `request`
now appends the gap's non-blank lines (trimmed, joined in reading order)
after the `│`-prefixed command body, when any are present — restoring parity
with the older chrome. `promptId`, however, is still hashed from the command
body ALONE (a separate `promptIdRequest` value, never returned), exactly as
before this ticket: the whole point of excluding gap content from the anchor
was to keep `promptId` naming the same prompt regardless of which reason (if
any) Claude renders there, and folding the reason text into the hash would
have reintroduced that instability by another route. A test asserts the same
command with two different reason texts (and with the reason absent
entirely) still yields the same `promptId`, while `request` differs.

A synthetic 3-option variant of this same chrome (built from the real
capture by dropping the stored-rule option, same method FACTORY-356 used for
its own synthetic fixtures) is also recognised — proof the fix generalises
across option count, since option parsing and the body-delimiter fix are
independent code paths.

**This ticket's other fingerprint (`bc2bdb0ac67037a1`, three options: `Yes /
Yes, and switch to auto mode / No`, no stored-rule option) was NOT confirmed
failing in the old chrome.** A genuine attempt was made to obtain a real
capture — asked the boss for an existing one (none available), then
reproduced offline three times (`claude --permission-mode default` in an
isolated scratch session, at two terminal widths, and with preceding
same-session scrollback) — every attempt produced the OLDER chrome (`─`
separator present, `Bash command` title above the body), which already
classified correctly before this fix too; it is the same shape as the
already-fixed FACTORY-318 "too-complex" family above. Committed at
`test/fixtures/bash-auto-mode-permission/pane-too-complex-3-option-old-chrome.txt`
as a real, verified-passing regression fixture — not as evidence this
fingerprint's bug reproduces.

**A too-complex command in the NEW (no-separator) chrome — the shape
FACTORY-385 closes — was also never reached by a real capture**, for the
same reason: every reachable offline repro kept producing the older chrome.
FACTORY-146's binary-string finding establishes on a sound, verifiable basis
(not a guess) what that dialog's reason slot carries, so
`test/fixtures/bash-auto-mode-permission/synthetic-too-complex-new-chrome.txt`
is a SYNTHETIC fixture, built the same way `synthetic-3-option-new-chrome.txt`
was: the real 4-option capture's own frame
(`pane-w29p1-4-option.txt`), with the body and reason line swapped for the
real too-complex fixture's own command and warning text
(`test/fixtures/too-complex-permission/brace-with-quote.txt`) and the
stored-rule option dropped (the too-complex family never offers one). Labeled
synthetic here and in its covering test, per the same honest-labeling
discipline used for this chrome's other synthetic fixture.

**Release-gate regression (director-mandated, FACTORY-372):** this
relaxation must not also let FACTORY-345/347's weekly-limit
`/rate-limit-options` command menu classify as a permission prompt — its
option 1 ends the session and option 3 spends money, so auto-pressing either
would be actively harmful, not merely wrong. That dialog asks `What do you
want to do?`, never matching the `QUESTION` gate's `Do you want to …?`
pattern, so it is rejected before any code this fix touches is ever reached
— pinned by a test against a real capture attributed to FACTORY-347
(`test/fixtures/rate-limit-options/`).

### The title-below-the-body-run anchor was too permissive on MCP-tool dialogs (FACTORY-392)

FACTORY-356 measured (comment 26934 on FACTORY-359, against `origin/main` at
`e63b7a3`) that the anchor above — the first non-blank line directly below a
contiguous `│`-prefixed run — also matches a generic MCP-tool dialog's own
frame. That dialog's description is itself a `│`-prefixed block, and Claude
draws `(ctrl+o to expand description)` directly below it, so this arm read
that hint line as `tool` instead of `undefined`:

```
   About the butchr — Tell Worker Tool:
   │ The ONLY way to speak DOWN to a worker: comments on ONE OF THE CALLER'S OWN workers'
   │ ticket. Refuses a `key` that is not one of the caller's own workers, verified via the…
   (ctrl+o to expand description)

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for butchr — Tell Worker commands in /tmp/claude-1002/…
   3. No

 Esc to cancel · Tab to amend
```

Real capture attributed to FACTORY-365/6 (fingerprint family
`bc2bdb0ac67037a1`/`a5901e30415b417e`), committed at
`test/fixtures/generic-mcp-tool-permission/pane-tell-worker-cropped.txt`.
`tool` came back `"(ctrl+o to expand description)"` — not merely wrong
cosmetically: `promptId = sha256([tool, request, question, options])`, so
every MCP-tool dialog on the fleet got a wrong fingerprint, and
`approvePermission`'s audit record logged the wrong tool name. It was
invisible to a naive check too — `classifyPermissionPrompt` still returned a
prompt, and `optionFor(once)` still resolved to option 1, so both "is it
recognised?" and "would it press Yes?" passed; only asserting the expected
`tool` value catches it.

**FACTORY-392's own fix was a narrow negative condition on this Bash arm
alone** (reject a candidate title line matching `(ctrl+o to expand
description)` rather than accept it, so this arm reported `undefined` for
the shape instead of a false positive) — written and reviewed while
FACTORY-365's MCP-tool arm was still unmerged. **By the time FACTORY-392's
PR was ready to merge, FACTORY-365 had already landed on `main`** with the
MCP-tool arm ABOVE ordered ahead of this Bash arm in the same no-separator
branch, which closes this exact gap more completely: an MCP-tool dialog is
now claimed by its own frame (`MCP_ABOUT`/`MCP_EXPAND_HINT`) and correctly
returns the real tool name, never reaching this Bash arm at all — a
strictly better outcome than the narrower `undefined` FACTORY-392's own
guard would have produced. FACTORY-392's guard was therefore dropped at
merge time as redundant dead code rather than carried forward; this
section is kept as a record of the measurement and the race, not as a
description of code still in `classifyPermissionPrompt`.

### The MCP-tool arm's own header can scroll off screen too (FACTORY-396)

"Redundant" above only held for the ordinary case, where the MCP-tool arm's
header search (`MCP_ABOUT`, scanning up from the expand hint) actually finds
`About the … Tool:`. FACTORY-396 is the case that section's own FACTORY-392
guard would have still caught and this one did not: a description long
enough that the header line itself is *also* scrolled off the visible
screen, not just the outer tool-call header/params/rule FACTORY-365's own
`pane-tell-worker-cropped.txt` fixture already covers. `aboutLine` stays -1,
and control falls through to the Bash arm below exactly as it did before
FACTORY-365 existed — misreading the expand hint (or, once that line alone
is excluded, an arbitrary `│`-prefixed description line still sitting
directly above another one) as `tool`.

Fixture (synthetic, labelled — no live pane with a description long enough
to scroll its own header off too was obtained; this ticket was filed and
worked unconfirmed by a real capture. Built by deleting this section's own
real capture's header line and everything above it, i.e. exactly what one
more line of scroll would remove, rather than a from-scratch guess):
`test/fixtures/generic-mcp-tool-permission/synthetic-tell-worker-about-line-scrolled-off.txt`.

```
   │ The ONLY way to speak DOWN to a worker: comments on ONE OF THE CALLER'S OWN workers'
   │ ticket. Refuses a `key` that is not one of the caller's own workers, verified via the…
   (ctrl+o to expand description)

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for butchr — Tell Worker commands in /tmp/claude-1002/…
   3. No

 Esc to cancel · Tab to amend
```

The fix is not a smarter header search — the header is genuinely off
screen, not merely hard to find, so there is no real tool name left to
return. Instead: whenever the expand hint's own frame is found (directly
above the question, nothing but blank lines between), that alone commits
the screen to being an MCP-tool dialog, whether or not its header was also
found. If the header wasn't found, `classifyPermissionPrompt` now returns
`undefined` rather than falling through to the Bash arm — never a guessed
`tool`. This subsumes FACTORY-392's narrower guard (which only excluded the
hint line itself as a candidate Bash title) rather than resurrecting it
verbatim: gating on `expandLine` also refuses the second-order case
FACTORY-392's own guard would have missed, where the Bash arm's title-scan,
having rejected the hint line, would otherwise keep scanning upward and
accept a `│`-prefixed description line as the title instead.

### A third no-separator sibling: the Edit/Create-file diff, header scrolled off (FACTORY-460/580)

An Edit/Create-file dialog draws the general `─` rule and an "Edit file"/
"Create file" title, same as a Bash dialog — but a dialog taller than the
pane scrolls that rule and title off the top just like any other, and its
body is a DIFF (bounded by `╌`, U+254C — a dashed border, never the general
arm's `─` rule and never the Bash chrome's `│`-prefixed run), so neither
pre-existing no-separator sibling fits. Before this fix, `classifyPermissionPrompt`
returned `undefined` here and `classifyBlockingScreen` reported
`kind: "unknown"` — the escalation FACTORY-460 was filed about, measured at
20 of 31 replayed stalls (agentvelocity, `bin/drovr-replay.mjs`).

Real captures (claude 2.1.251, `--permission-mode default`, driven live via
`herdr agent prompt` + `herdr pane read`; full provenance in
`test/fixtures/file-edit-approval/README.md`):

```
 Edit file
 NOTES.md
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 1  hello
 2
 3  ## capture
 4 +
 5 +## second edit
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to make this edit to NOTES.md?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for
      this session (shift+tab)
   3. No

 Esc to cancel · Tab to amend
```

With the header scrolled off (`test/fixtures/file-edit-approval/synthetic-notes-md-edit-scrolled-off-3-rows.txt`,
a truncation of the capture above, never an invented screen), nothing is
left above the question but the diff body itself:

```
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 1  hello
 2
 3  ## capture
 4 +
 5 +## second edit
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to make this edit to NOTES.md?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for
      this session (shift+tab)
   3. No

 Esc to cancel · Tab to amend
```

The ONLY anchor left on a screen this scrolled is the diff's own CLOSING
`╌` border, sitting immediately above the question with no gap on every
capture measured — never screen position, line number, or distance, per the
invariant the rest of this file documents. Recognition works upward from
there: the question must match "Do you want to (make this edit to|create)
X?" (so `tool` is synthesized as "Edit file"/"Create file" from the
dialog's own content — never scrollback — and `X` is the basename), the
option set must equal exactly `["Yes", <the accept-edits option>, "No"]`
(GUARD 2's exact-label-set half — a torn `3. Nossion` already fails the
earlier generic `/^No\b/` check before this arm is ever reached, but this is
additional narrowing specific to this shape), and the body between the
closing border and the opening `╌` border above it is the diff content,
verbatim. The opening border is the ONLY anchor for where that body actually
starts; if it has ALSO scrolled off (an even taller dialog, or a shorter
pane), there is nothing left to bound the body by, so recognition REFUSES
(`undefined`) instead of falling back to whatever scrollback happens to sit
above the closing border (GUARD 5, FACTORY-583:
`test/fixtures/file-edit-approval/synthetic-notes-md-edit-scrolled-off-mid-diff.txt`
is kept as the negative proof of this — it is NOT a recognised capture). An
earlier version of this fix fell back to line 0 in that case, which let
`request` — and so `promptId` — drift with however much unrelated pane
chatter happened to precede the dialog on a given read: prepending a single
`⏺ Bash(ls)` line to that fixture changed promptId from `6224bec08f0ba851` to
`46d1fcdd55a314bb`. That broke the exact invariant this file opens with
(`promptId` is a function of the dialog's own content, never scrollback —
see FACTORY-327, FACTORY-356, FACTORY-396) and reproduced FACTORY-460's own
symptom: `approvePermission`'s re-read sees a different promptId, refuses
`prompt-changed`, and the dialog is never answered.

**GUARD 6 — the backward scan for the opening border is bounded to this
dialog's own frame (FACTORY-586).** The scan above does not merely stop when
the opening border is missing (GUARD 5) — it also stops the instant it
crosses a line that marks the edge of some OTHER dialog: a `QUESTION` line
(`Do you want to …?`), an `OPTION` line (a numbered `1. …`/`2. …` choice), or
an `Esc to cancel` footer. Without that bound, intervening scrollback holding
an EARLIER dialog's entire frame — its own question, its own options, its
own footer, and its own `╌` border — let the scan walk straight through the
live dialog's frame and latch onto the older one's border instead, silently
treating the older dialog's diff as this one's body. Worse, because `q` above
is already the FIRST question found on screen, an earlier dialog whose own
question line is still literally present would make the WHOLE prompt —
`tool`, `path`, `request`, `promptId` — resolve to the OLDER dialog while the
pane is actually showing the live one. A weaker variant needs no second
dialog at all: any stray `╌{10,}` run anywhere above the live dialog — a
decorative rule, unrelated chatter that happens to contain the character —
became an "opening border" the unbounded scan was willing to accept,
absorbing everything between it and the live closing border into `request`.
REACHABILITY OF THE TWO-LIVE-DIALOG CASE IS NOT ESTABLISHED — this is a
mechanism closed defensively, not a reproduced field failure (see
FACTORY-586's own ticket text) — but the weaker single-stray-border variant
needs no second dialog to matter, and both are closed the same way: stop and
refuse (`undefined`) rather than accept a border found past the boundary.
This mirrors the no-separator MCP-tool arm's own header search above, which
stops at a blank line, `SEPARATOR`, or `QUESTION` for the identical reason —
never let one dialog's recognition reach into another's frame for an anchor.
Two derived negative probes exercise this, assembled by hand from the
committed captures above rather than invented from scratch (per this file's
fixture-first practice, a negative test — refusing MORE — needs no real
capture to be legitimate): `test/fixtures/file-edit-approval/synthetic-earlier-dialog-frame-plus-live-no-opening-border.txt`
(an earlier dialog's closing border, options and footer, prefixed onto a live
capture with its own opening border removed) and `synthetic-stray-border-above-live-no-opening-border.txt`
(a bare stray `╌` run plus an `Esc to cancel`-shaped boundary, prefixed the
same way) — both classify as `undefined`; verified by hand against the
pre-FACTORY-586 scan that both were previously RECOGNISED, with the
intervening footer/options/chatter absorbed into `request`.

**GUARD 7 — two further refusals (FACTORY-587, from review of the GUARD 6
change).** GUARD 6's bound only trips on lines ABOVE `q`, the FIRST question
on screen, so it cannot catch an earlier dialog whose own question line is
still visible: `q` is then that older question and the live dialog is never
examined. Measured probe: a COMPLETE earlier edit dialog (opening border,
diff, closing border, question, 3 options, `Esc to cancel`) above a live
dialog with its opening border scrolled off was still recognised, with the
older diff as `request`. Now recognition refuses (`undefined`) when more than
one `QUESTION` line is on screen, rather than guess which is live. Second,
a bare stray `╌{10,}` line followed by plain chatter (no QUESTION/OPTION/`Esc
to cancel` line between it and the live closing border) was still absorbed;
every diff body line carries the line-number gutter (`1  …`, `4 +…`), so the
body must now consist solely of gutter lines or recognition refuses. Both
only ever refuse MORE. Derived negative probes (not sightings):
`synthetic-earlier-dialog-with-question-plus-live-no-opening-border.txt` and
`synthetic-stray-border-chatter-above-live-no-opening-border.txt`.

**GUARD 1 — the `path` field, and a finding that corrects FACTORY-460's own
premise.** The question line carries only the basename (confirmed: 0 of the
2 edit/create captures taken for this fix had a path in it). FACTORY-460
claimed "the directory is in option 2 … present in 25 of 25 edit/create
captures" as a universal rule; that does NOT hold on this host's claude
2.1.251. It holds only when the edited file is OUTSIDE the session's
already-trusted root — a finding that falsified the original premise, but is
not itself the fail-closed guarantee; see GUARD 1(c) below for the part
that actually is:

```
 Do you want to make this edit to OUTSIDE.md?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for
      this session; Yes, and always allow access to /tmp/claude-1002/outside-dir for this
      session (shift+tab)
   3. No
```

— one option, wrapped onto three physical lines, granting BOTH the
accept-edits toggle and the directory access in the same affirmative choice.
When the edited file is already inside the trusted root (the common case),
option 2 carries no directory at all (`pane-notes-md-edit-header-visible.txt`
above). `path` is therefore `undefined` whenever either half fails to
parse — which in practice means whenever the file is already trusted — never
a partially-built path, and never a guess at wording this fix has not
actually captured. This derivation is shared by every arm (a small
`makePermissionPrompt` helper), so an already-header-visible Edit/Create
dialog (the general `SEPARATOR` arm, unchanged) gets the same `path` an
otherwise-identical header-scrolled-off capture gets from this sibling.
`path` being `undefined` here is NOT, by itself, fail-closed — it is only a
derivation refusing to guess. Until FACTORY-584, the shape stayed fully
*answerable* despite that: `optionFor(prompt, "once")` returned plain
`"Yes"`'s index regardless of `path`, so the common in-trusted-root case
(`path === undefined`) was pressed anyway, with no path ever known. A PR
comment and an earlier revision of this doc called that branch
"fail-closed"; it was the permissive one. GUARD 1(c) is the actual
fail-closed guarantee.

**GUARD 1(b)/GUARD 4 — `scope: "always"` is refused for this shape, inside
drovr, unconditionally.** On EITHER capture above, option 2 ALSO switches
the session to accept-edits mode (auto-approving every future file edit),
whether or not it carries a directory grant in the same breath. `optionFor`
therefore returns `-1` for `scope: "always"` whenever `tool` is "Edit file"
or "Create file", regardless of what the caller asks for — this is the only
thing standing between drovr's own default scope (`"always"`,
`AutoAnswerPermissionsOptions.scope`) and an unattended pass auto-accepting
every future edit. butchr's live path already passes `scope: "once"`
independently (`src/agents/permission-answer-loop.ts`), but this refusal
does not rely on that.

**GUARD 1(c) — `scope: "once"` is ALSO refused when `path` is `undefined`
(FACTORY-584), making the dialog unanswerable, not merely unprivileged.**
GUARD 1(b) above refuses `"always"` unconditionally for this shape; until
FACTORY-584 that left `"once"` free to press plain `"Yes"` even when `path`
could not be derived — the common case, every in-trusted-root edit. Derived
`path` on its own never caused anything; it was only ever stored on the
`PermissionPrompt` for the one-off caller that wants it. Completing the
missing directory from the pane's own `cwd` was considered and rejected on
FACTORY-580 before this ticket existed: "inside the trusted root" means
anywhere under it, the question line carries only the basename, so
`<cwd>/<basename>` for an edit to `<root>/src/foo.ts` would derive
`<root>/foo.ts` — a guessed path wearing a derived path's clothes, the
exact thing this guard forbids — and the pane's reported `cwd` is not
reliably the session's trusted root to begin with. `optionFor` now returns
`-1` for scope `"once"` too, whenever `tool` is "Edit file" or "Create
file" and `path === undefined` — regardless of what the caller asks for,
the same unconditional shape GUARD 1(b) already uses for `"always"`.

Concretely: `autoAnswerPermissions` (scope `"once"`, butchr's live default)
now returns `skipped` for this shape with no `approvePermission` call at
all, so no `"approving"` audit record is written and no keys are sent —
see "A prompt without that option in that position is skipped" above.
`createBlockingEscalationWatcher`'s `escalationPayload`
(`docs/blocking-escalation.md`) escalates precisely when
`optionFor(permission, permissionScope) < 0` for a recognised dialog, so
this now reaches a human through the existing FACTORY-318 path — with
`question`/`options` copied verbatim and a content-stable fingerprint — the
same mechanism and nothing new. An outside-root edit, where `path` IS
derivable, is unaffected: `optionFor("once")` still returns plain `"Yes"`'s
index for it, exactly as before.

Not claimed here: the in-root/outside-root split of FACTORY-460's 20 class-1
captures is unmeasured on this host — `bin/drovr-replay.mjs` and
agentvelocity's captures would answer it, and doing so is outstanding, not
this ticket's to estimate. Nor is this a statement that `(c)` (answering
with an explicitly-unknown path, left to a consumer-side policy) is
implemented anywhere — it isn't, and shipping it needs admin-agentsafety's
sign-off, not this repo's.

**GUARD 2 — torn captures.** The exact-option-label-set half lives in
recognition (above); the two-identical-reads half is unchanged, already a
property of `approvePermission`'s re-read-before-pressing design (see
Guarantees below) — this fix adds no new torn-capture handling to the
answering path, only the narrower recognition gate. A negative fixture,
`test/fixtures/file-edit-approval/synthetic-notes-md-edit-torn-option-scrolled-off.txt`
(the header-scrolled-off capture with `No` hand-mutated to `Nossion`, per
FACTORY-460's class 3), is pinned as unrecognised. Per the fixture-first
rule, a negative test does not need a real tear to be legitimate — refusing
more is always safe.

**GUARD 3 (drovr's half) — attributable audit/results.** Every `PermissionPrompt`
now carries `recognizedVia`: `"separator"`, `"no-separator-mcp-tool"`,
`"no-separator-bash"`, or `"no-separator-file-edit"` — which arm classified
the screen. It flows into every audit record `approvePermission` writes
(the `shown` object merged into `record()`) and into `ApprovePermissionResult`/
`AutoAnswerPermissionResult`'s `answered`/`ok: true` variants. To find every
auto-answer that went through this new, previously-unrecognised fallback:
`grep '"recognizedVia":"no-separator-file-edit"'` over the JSONL audit file.

**Not in scope.** FACTORY-460's class 2 (a blank line inside the option
block) has no real capture on this host and is not fixed here — the option
loop is unchanged. Class 3 (the torn label) is pinned as a negative test,
never "fixed" — recognising it would be wrong. Class 4 (~9 unclassified
captures) and the 50-capture replay need `bin/drovr-replay.mjs` and
agentvelocity's captures, neither of which exist on this host; both are
reported as outstanding on the ticket rather than estimated.

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
  scope: "once",           // optional; default "always" (see "Scope" below)
});
// [{ paneId: "w1:p1", label, outcome: "answered", tool, request }
//  { paneId: "w2:p1", label, outcome: "skipped", reason }
//  { paneId: "w3:p1", label, outcome: "failed", reason, detail }]
```

One unattended pass over every pane `listPendingPermissions` reports, with no
operator in the loop: every prompt is answered with the option for
`options.scope`, and nothing else.

- **Scope (FACTORY-93).** `"always"` (the default, unchanged) presses option 2
  only when it is the "Yes, and …" stored-rule option. `"once"` presses
  option 1 only when it is exactly `Yes` — no stored rule, and no dependence
  on how Claude words its "always allow" option. Claude's read-permission
  dialog words it "Yes, allow reading from … from this project" (no "and"), so
  `"always"` skips that dialog; `"once"` answers it. Butchr's lizard mode uses
  `"once"`. A `"once"` prompt whose option 1 is not `Yes` is `skipped` with a
  reason, nothing pressed.

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

## A blank row inside the wrap was ALSO invisible (FACTORY-603/604/605)

DROVR-41 above tolerated a wrapped continuation line with no blank row
around it. FACTORY-603 measured (and agentvelocity's live daemon captures,
FACTORY-603 comment 28606, confirmed) that the SAME wrap can also leave a
blank — or merely whitespace-only, `line.trim() === ""` rather than
`line === ""` — row INSIDE the option block: before the continuation, after
it, or between two numbered options. `CONTINUATION` (`/^\s+\S/`) requires a
non-whitespace character, so that row never matched it either, and the
dialog was invisible in exactly the same way DROVR-41 fixed for the
no-blank-row case: `classifyPermissionPrompt` returned `undefined`, the
trailing `No` option and the footer window were both lost, and
`listPendingPermissions` never surfaced the pane.

```
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, allow reading from /home/…/agentcost-capture/packages/collector/
      src/backfill from this project

   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
```

Fixed: a bounded run of whitespace-only rows (`MAX_OPTION_BLANK_RUN`,
currently 2 — bounded for the same reason `MAX_TITLE_GAP_LINES` is bounded
above, not "blank rows anywhere") is now tolerated INSIDE one dialog's own
option block. The discriminator is the dialog's own content, never screen
position: after skipping the blank run, the next non-blank row must either
fold into the option above it (a `CONTINUATION` row) or continue this
block's own numbering (an `OPTION` row numbered exactly one past the last
option collected — `OPTION`'s own number, previously matched but discarded,
is now captured for this purpose). Anything else — a fresh `QUESTION` or
`SEPARATOR`, the `Esc to cancel` footer, an unindented stray line, or a
blank run followed by an option numbered `1.` (a second dialog's own block)
— still ends the list exactly as before this change; the footer's own
trailing blank line before "Esc to cancel" is one case of this, not a
special case; it is covered by the same discriminator, not exempted from
it.

**This is recognition only, and recognition is not the same as safety.**
The option-collection loop runs before all four recognition arms above, so
the fix is arm-independent: any dialog whose option block carries a blank
row is now reachable, not only the read-only "allow reading from `<dir>`"
shape FACTORY-603 measured. In particular, FACTORY-603's real captures also
include the OTHER wrapped label, "Yes, and don't ask again for: `<command>`"
— including an `rm -f` approval and a Claude Code "manual approval
required" compound-command warning — which were equally invisible before
this fix. Recognising them is **pre-existing policy newly reached, not new
policy**: `optionFor`'s `/^Yes, and\b/` match (GUARD-adjacent, not itself a
GUARD) already presses that exact option set on the UNWRAPPED equivalent of
that shape today, under drovr's own default `scope: "always"` — DROVR-41's
own fixture above proves it. This fix does not change `optionFor`, does not
add a refusal, and does not scope the tolerance to one label shape; it
simply makes a screen that carries that shape, wrapped with a blank row,
reachable the same way its unwrapped twin already is. The read-only "allow
reading from `<dir>`" shape is unaffected either way: its label is "Yes,
allow…", never "Yes, and…", so `optionFor(_, "always")` returns `-1` for it
regardless of this fix, exactly as before. Both halves of this claim — the
stored-rule shape's answer decision under both scopes, and the read-only
shape's refusal under `scope: "always"` — are pinned directly by test in
`test/permission-approval.test.ts`, through both `optionFor` and the real
`autoAnswerPermissions` path, so any future change to the answered set is a
visible diff rather than an incidental discovery.

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
