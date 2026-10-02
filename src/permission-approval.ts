import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { stripTerminalEscapes } from "./blocking-conditions.js";
import type { DrovrClient } from "./drovr-client.js";
import { readPaneWithDeadline, type PaneReadDeadlineOptions, type UnreadablePane } from "./pane-scan.js";

/**
 * Approving a session's pending tool-permission prompt without a terminal.
 *
 * What this answers: Claude's "Do you want to proceed?" dialog, which a
 * session in a default or ask permission mode shows before a tool call and
 * then waits on. Measured on claude 2.1.277 in a herdr pane (2026-09-18):
 *
 *   ─────────────────────────────────────────
 *    Bash command
 *    Tip: auto mode handles these prompts for you — …
 *
 *      touch drovr-permission-probe.txt
 *      Create empty probe file
 *
 *    Do you want to proceed?
 *    ❯ 1. Yes
 *      2. Yes, and always allow access to /tmp/… from this project
 *      3. Yes, and switch to auto mode · auto mode handles these prompts for you
 *      4. No
 *
 *    Esc to cancel · Tab to amend
 *
 * Three more measured shapes, each missing one of the preconditions above
 * and each recognised by a narrow, shape-specific fallback rather than by
 * loosening the general rule — the no-separator ones are tried as siblings
 * in the same fallback arm, never as a shared implementation:
 *
 * - A generic MCP-tool dialog (FACTORY-365/6, claude 2.1.251) draws no `─`
 *   rule anywhere on screen, framing its body instead with `About the
 *   <server> — <Tool> Tool:` and `(ctrl+o to expand description)`. A tool
 *   call whose displayed parameters are long enough scrolls that frame's
 *   header line off a real pane's *visible* screen too, leaving only the
 *   description onward above the question — still recognised, from the
 *   description frame alone.
 * - WebFetch (FACTORY-365/6) draws the rule but no `Esc to cancel` footer at
 *   all; its escape hint lives inline in the "No, …" option's own text as
 *   `(esc)`, accepted only when the dialog's own body also carries "Claude
 *   wants to fetch content from …" verbatim — never based on screen
 *   position, which broke on ordinary trailing chatter landing on a
 *   still-live pane.
 * - A second, newer chrome for the same Bash dialog (FACTORY-372, claude
 *   2.1.251, real capture attributed to FACTORY-356/FACTORY-359 comment
 *   26534, pane `w29:p1`, 2026-09-27) also draws no `─` rule at all. Its
 *   body block (the command, `│`-prefixed) sits ABOVE the title line
 *   instead of below it, followed by a reason line — `This command requires
 *   approval` on this capture:
 *
 *      │ git commit -m "$(cat <<'EOF'
 *      │ ...
 *      │ EOF
 *      │ )"
 *      │ git log --oneline -3
 *    Run shell command
 *
 *    This command requires approval
 *
 *    Do you want to proceed?
 *    ❯ 1. Yes
 *      2. Yes, and don't ask again for: git commit -m ' *
 *      3. Yes, and switch to auto mode · auto mode handles these prompts for you
 *      4. No
 *
 *    Esc to cancel · Tab to amend · ctrl+e to explain
 *
 *   FACTORY-146 (comment 26827 on FACTORY-359) grepped the installed binary
 *   directly and found that `This command requires approval` and a
 *   `too-complex` command's security-warning text (e.g. `Contains brace with
 *   quote character (expansion obfuscation)`) are both `reason` strings
 *   rendered in that SAME slot, as alternatives, never together — so a
 *   too-complex command in this chrome carries a warning line there instead,
 *   and the family of possible reason strings is open-ended (confirmed
 *   adjacent in the binary's own string table). Recognition is therefore
 *   keyed on the two lines that are actually invariant regardless of which
 *   reason (or none) occupies that slot: the contiguous `│`-prefixed body
 *   run, and the title line directly below it — never on any reason line's
 *   text. Whatever sits between the title and the question is bounded to a
 *   small fixed number of non-blank lines (`MAX_TITLE_GAP_LINES`) and
 *   otherwise ignored, rather than required to match specific wording.
 *
 * Real panes interleave butchr's own notification chatter (including a
 * `▔▔▔▔`/U+2594 rule) in the same frame, with its position shifting between
 * reads; a fix keyed on screen position or a wider rule-character class
 * would let that chatter supply a separator/anchor the screen never earned.
 * Each fallback above anchors on the dialog's own frame instead, which also
 * keeps `promptId` stable across differing scrollback — the SEPARATOR line
 * was previously both the recognition gate AND the body delimiter that
 * `tool`/`request`/`promptId` derive from, so a fix that merely dropped the
 * gate without a bounded replacement delimiter would make `promptId` drift
 * with scrollback (FACTORY-327, FACTORY-356 comment 26576 on FACTORY-359).
 *
 * See `docs/permission-approval.md` for the full captured screens.
 *
 * FACTORY-392 measured (against `origin/main` at `e63b7a3`, before the MCP
 * arm above existed) that this title-below-the-body-run anchor was TOO
 * PERMISSIVE on its own: a generic MCP-tool dialog's own description block
 * is ALSO a contiguous `│`-prefixed run, with `(ctrl+o to expand
 * description)` sitting directly below it, so the Bash arm alone — with no
 * MCP arm ahead of it to claim that shape first — read that hint line
 * itself as `tool`, corrupting `promptId` for every MCP-tool dialog
 * fleet-wide. The MCP-tool arm above, and its ordering ahead of the Bash
 * arm (tried first, in this same no-separator branch), is what closes that
 * gap for the ordinary case: an MCP-tool dialog is claimed by its own, more
 * specific frame before the general Bash anchor ever sees it.
 *
 * FACTORY-396: that ordering alone is NOT sufficient — it only helps once
 * the MCP-tool arm's OWN header search succeeds. If the dialog's
 * description is long enough that `About the … Tool:` is *also* scrolled
 * off the visible screen (not just the outer tool-call header/params/rule
 * FACTORY-365's own fixture already covers), `aboutLine` stays -1 and
 * control still falls through to the Bash arm below, which is exactly the
 * FACTORY-392 false-positive again, just gated on a longer description.
 * The fix is not a smarter header search (the header is genuinely gone, not
 * merely hard to find) but a refusal to fall through at all: whenever the
 * expand hint's own frame is present — found directly above the question,
 * with nothing but blank lines between — this is decisively an
 * (unrecognisable) MCP-tool dialog and never a Bash one, so the code
 * returns undefined instead of letting the Bash arm guess a `tool` out of
 * the hint line or an arbitrary description line above it.
 *
 * A fourth no-separator sibling (FACTORY-460/580): an Edit/Create-file
 * dialog whose `─` rule and "Edit file"/"Create file" title have scrolled
 * off a pane shorter than the dialog. Its body is a DIFF, bounded by `╌`
 * (U+254C — distinct from the general rule's U+2500), never the Bash arm's
 * `│`-prefixed run, so neither pre-existing sibling fits. The only anchor
 * left is the diff's own closing `╌` border, sitting with no gap directly
 * above the question. See `docs/permission-approval.md` for the full
 * captured screens, including a finding that corrects this family's own
 * prior assumption: the directory this shape's `path` field needs is in
 * option 2 ONLY when the edited file is outside the session's
 * already-trusted root — inside it, option 2 carries no directory at all,
 * and `path` is `undefined`. `optionFor` (GUARD 1(c), FACTORY-584) then
 * refuses both scopes for an `undefined` `path`, so the prompt escalates
 * instead of being answered.
 *
 * What it cannot answer: an auto-mode classifier denial. That refuses the
 * tool call outright and leaves nothing on screen to approve; only a
 * permission rule the session reads at start can change it.
 *
 * Never chosen, whatever the caller asks: switching the session to auto mode.
 */

type ApprovalClient = {
  agent: Pick<DrovrClient["agent"], "list" | "get" | "read" | "sendKeys">;
};

export interface PermissionPrompt {
  /** The dialog's title line, e.g. "Bash command". */
  tool: string;
  /** What the tool will do, as the dialog shows it (a command, a path, a diff). */
  request: string;
  /** e.g. "Do you want to proceed?" */
  question: string;
  options: string[];
  /** Index into `options` of the option under the cursor. */
  cursor: number;
  /** A hash of tool, request, question and options: names this prompt, not the cursor position. */
  promptId: string;
  /**
   * Full path for an "Edit file"/"Create file" dialog (FACTORY-460/580):
   * the directory named in option 2's "…always allow access to <dir> for
   * this session" text, plus "/", plus the basename the question line
   * carries. `undefined` whenever EITHER half fails to parse — never a
   * partial path, never a guess — which in practice means `undefined`
   * whenever the edited file is already inside the session's trusted root:
   * option 2 then carries no directory at all (see
   * `test/fixtures/file-edit-approval/README.md`, which falsifies the "25 of
   * 25 captures had a directory" premise this field was originally specified
   * against). `undefined` on every other dialog shape. The fail-closed
   * guarantee itself lives in `optionFor` (GUARD 1(c), FACTORY-584), which
   * refuses both scopes whenever `path` is `undefined` here — this field
   * being `undefined` is only the derivation declining to guess, not by
   * itself what makes the prompt unanswerable.
   */
  path: string | undefined;
  /**
   * True when the option-collection loop had to skip a blank or
   * whitespace-only row INSIDE the option block to recognise this prompt at
   * all (FACTORY-603/604/605) — never when the dialog's unwrapped twin
   * would already recognise it without that skip. `optionFor` uses this,
   * not `recognizedVia` or any other field, to decide which tolerated
   * prompts it may answer: see the comment there.
   */
  blankRowTolerated: boolean;
  /**
   * Which arm of `classifyPermissionPrompt` recognised this screen (GUARD 3,
   * FACTORY-460/580): `"separator"` for the general rule-gated arm,
   * `"no-separator-mcp-tool"`/`"no-separator-bash"` for the two pre-existing
   * no-separator siblings, and `"no-separator-file-edit"` for the new one
   * this ticket adds. Carried into the audit record's `shown`/outcome
   * fields and into `AutoAnswerPermissionResult`'s `answered` variant so a
   * reader can grep specifically for auto-answers that went through the new,
   * previously-unrecognised fallback: `grep '"recognizedVia":"no-separator-file-edit"'`.
   */
  recognizedVia: "separator" | "no-separator-mcp-tool" | "no-separator-bash" | "no-separator-file-edit";
}

const SEPARATOR = /^\s*─{10,}\s*$/;
const QUESTION = /^\s*(Do you want to .+\?)\s*$/;
const OPTION = /^\s*(❯\s*)?(\d+)\.\s+(.+?)\s*$/;
/** A wrapped option's continuation line: indented text with no number of its own. */
const CONTINUATION = /^\s+\S/;
/**
 * A generic MCP-tool dialog's own header, e.g. `About the butchr — Tell
 * Worker Tool:` — the body delimiter it draws instead of a `─` rule.
 */
const MCP_ABOUT = /^\s*About the (.+):\s*$/;
/** The line the MCP-tool frame always ends its description on, right before the blank line and the question. */
const MCP_EXPAND_HINT = /^\s*\(ctrl\+o to expand description\)\s*$/;
/** A description line's own `│` (U+2502) prefix, stripped before joining into `request`. Identical to `BASH_BODY_LINE_PREFIX` below — kept as two names since each fallback owns its own capture/vocabulary, not because the pattern differs. */
const DESCRIPTION_LINE_PREFIX = /^\s*│\s?/;
/**
 * A `No, …` option carrying its own inline `(esc)` hint — WebFetch's stand-in
 * for a footer `Esc to cancel` line, which it never draws at all.
 *
 * Not anchored to end-of-string (FACTORY-386): an indented trailing line
 * after the option list (e.g. butchr's own notification chatter landing on
 * a still-live pane) folds onto this option via `CONTINUATION`, pushing
 * `(esc)` away from the end. The end-anchor used to carry anti-spoof
 * weight, but `WEBFETCH_BODY_MARKER` carries that instead — see its check
 * below.
 */
const INLINE_ESC_OPTION = /^No\b.*\(esc\)/;
/** WebFetch's own body always carries this verbatim — the shape anchor for the inline-`(esc)` relaxation, so it can't be spoofed by a quoted option list alone. */
const WEBFETCH_BODY_MARKER = /Claude wants to fetch content from/;
/** A body line's own `│` (U+2502) prefix in the newer no-separator Bash chrome, stripped before joining into `request`. */
const BASH_BODY_LINE_PREFIX = /^\s*│\s?/;
/**
 * How many non-blank lines are tolerated between the title line and the
 * question in the newer no-separator Bash chrome (FACTORY-385). That gap
 * holds whatever reason line Claude renders there — `This command requires
 * approval`, a too-complex security warning, or (per the binary's own string
 * table, FACTORY-146 comment 26827) any of an open-ended family of others —
 * never both, and never something this code keys on by text. A small fixed
 * bound, not "blank lines only" and not unbounded, is what keeps that
 * flexibility from also letting unrelated chatter manufacture a title line
 * the screen never earned.
 */
const MAX_TITLE_GAP_LINES = 3;
/**
 * How many consecutive whitespace-only rows are tolerated INSIDE one
 * dialog's own option block (FACTORY-603/604/605) — e.g. between a long
 * option label's own text and its wrapped `CONTINUATION` row, or between
 * two numbered options. A long "allow reading from <dir>" label wraps onto
 * a blank or whitespace-only row (measured: `line.trim() === ""`, not
 * literal emptiness) often enough to make these dialogs invisible
 * (`classifyPermissionPrompt` returns `undefined`) rather than refused. A
 * small fixed bound, not "unbounded blank rows", is what keeps that
 * tolerance from also letting unrelated scrollback far below this dialog's
 * own frame supply a match the screen never earned — the same reasoning
 * `MAX_TITLE_GAP_LINES` above already applies to the title-to-question gap.
 */
const MAX_OPTION_BLANK_RUN = 2;
/**
 * An Edit/Create-file dialog's own diff-body border (U+254C, distinct from
 * the general `SEPARATOR`'s U+2500): drawn both directly above and directly
 * below the diff, with the closing one sitting immediately above the
 * question with no gap on every capture measured (FACTORY-460/580). It is
 * the only anchor left once the dialog's `─` rule and "Edit file"/"Create
 * file" title have scrolled off a pane shorter than the dialog.
 */
const DIFF_BORDER = /^\s*╌{10,}\s*$/;
const DIFF_GUTTER = /^\d+(\s|$)/;
/**
 * The file-edit/create question itself names the operation and carries the
 * BASENAME only (FACTORY-460: 0 of 25 edit/create captures had a path in the
 * question line) — captured here so both recognition and the `path`
 * derivation below read it from the dialog's own content, never a guess.
 */
const FILE_EDIT_QUESTION = /^Do you want to (make this edit to|create) (\S.*)\?$/;
/**
 * The file-edit/create dialog's own "Yes, and …" option, measured in two
 * shapes on claude 2.1.251 (`test/fixtures/file-edit-approval/README.md`):
 * plain, when the edited file is already inside the session's trusted root,
 * and compound — wrapping a second "Yes, and always allow access to <dir>
 * for this session" grant into the SAME option — when it is not. Capturing
 * group 1 is the directory, present only in the compound form; `undefined`
 * on the plain form is not a parse failure, it is the dialog correctly
 * reporting "no directory to grant" for an already-trusted path — `optionFor`
 * then refuses both scopes for a prompt whose derived `path` is `undefined`
 * (GUARD 1(c)). This option is also the one `optionFor` below refuses for
 * `scope: "always"` unconditionally, because on EITHER shape it switches the
 * session to accept-edits mode — GUARD 1(b)/GUARD 4.
 */
const FILE_EDIT_OPTION_2 =
  /^Yes, and switch to accept edits \(auto-approve file edits and common file commands\) for this session(?:; Yes, and always allow access to (.+) for this session)? \(shift\+tab\)$/;

/**
 * Shared tail for every recognised arm: computes `promptId` and the
 * Edit/Create-file `path` (GUARD 1) identically regardless of which arm
 * classified the dialog, so an already-header-visible Edit/Create dialog
 * (the general `SEPARATOR` arm) gets the same `path` logic an otherwise
 * identical header-scrolled-off capture gets from the sibling below.
 */
function makePermissionPrompt(
  tool: string,
  request: string,
  promptIdRequest: string,
  question: string,
  options: string[],
  cursor: number,
  recognizedVia: PermissionPrompt["recognizedVia"],
  blankRowTolerated: boolean,
): PermissionPrompt {
  const promptId = createHash("sha256").update(JSON.stringify([tool, promptIdRequest, question, options])).digest("hex").slice(0, 16);
  let path: string | undefined;
  if (tool === "Edit file" || tool === "Create file") {
    const basename = FILE_EDIT_QUESTION.exec(question);
    const directory = options[1] !== undefined ? FILE_EDIT_OPTION_2.exec(options[1])?.[1] : undefined;
    if (basename && directory) path = `${directory}/${basename[2]}`;
  }
  return { tool, request, question, options, cursor, promptId, path, recognizedVia, blankRowTolerated };
}

/**
 * The third no-separator sibling (FACTORY-460/580): an Edit/Create-file
 * dialog whose `─` rule and title have scrolled off a pane shorter than the
 * dialog, leaving nothing above the question but the diff body itself. The
 * ONLY anchor available on a screen this scrolled is the dialog's own
 * closing `╌` border directly above the question — no gap, matching every
 * capture measured (`test/fixtures/file-edit-approval/`) — plus the
 * question's and the option set's own exact wording. Never screen position,
 * line number, or distance, per the invariant documented atop this file.
 *
 * GUARD 2 (exact option-label-set half, FACTORY-460): `options` must equal
 * exactly `["Yes", <FILE_EDIT_OPTION_2>, "No"]` — not merely start with
 * "Yes" and contain a "No" option, which the earlier generic check already
 * requires but which alone is loose enough for an unrelated no-separator
 * dialog to coincidentally satisfy. A torn capture (e.g. `3. Nossion`)
 * already fails the generic `/^No\b/` check before this function is ever
 * called; this is additional, shape-specific narrowing on top of that.
 *
 * GUARD 5 (FACTORY-583): the OPENING `╌` border — the only anchor for where
 * the diff body actually starts — can itself be scrolled off a pane shorter
 * than the diff, leaving only the closing border above the question. There
 * is no fallback delimiter for that case: a pane this short carries no
 * anchor at all for where the body begins, so recognition refuses
 * (`undefined`) rather than let `body` absorb whatever scrollback happens to
 * sit above the closing border, which would make `promptId` a function of
 * scrollback again — the exact invariant documented atop this file.
 *
 * GUARD 6 (FACTORY-586): the backward scan for the opening border is itself
 * bounded to THIS dialog's own frame. Without a bound, intervening
 * scrollback holding an EARLIER dialog's entire frame — its question, its
 * option list, its `Esc to cancel` footer, and its own `╌` border — would
 * let the scan walk straight through the live dialog's frame and latch onto
 * the older one's border instead, silently importing that older dialog's
 * diff as if it were this one's body (and, because `q` above is already the
 * FIRST question on screen, misattributing the whole prompt to the older
 * dialog). A `QUESTION` line, an `OPTION` line, or an `Esc to cancel` line
 * all mark that boundary — crossing any of them means the scan has left this
 * dialog's own frame, so it stops and refuses rather than accept a border
 * found on the far side. This mirrors the no-separator MCP-tool arm's own
 * header search above, which stops at a blank line, `SEPARATOR`, or
 * `QUESTION` for the same reason: never let one dialog's recognition reach
 * into another's frame for an anchor.
 */
function classifyFileEditNoSeparator(
  lines: string[],
  q: number,
  question: string,
  options: string[],
): { tool: string; request: string } | undefined {
  if (q === 0 || !DIFF_BORDER.test(lines[q - 1]!)) return undefined;
  const match = FILE_EDIT_QUESTION.exec(question);
  if (!match) return undefined;
  if (options.length !== 3 || options[2] !== "No" || !FILE_EDIT_OPTION_2.test(options[1]!)) return undefined;
  // FACTORY-587: `q` is the FIRST question on screen, and the scan below
  // starts above it, so a second question anywhere means an earlier dialog's
  // question sits above the live one and the live frame is never examined.
  // Only ever stricter: refuse rather than guess which question is live.
  if (lines.some((line, i) => i !== q && QUESTION.test(line))) return undefined;
  let open = -1;
  for (let i = q - 2; i >= 0; i--) {
    const line = lines[i]!;
    if (DIFF_BORDER.test(line)) { open = i; break; }
    // FACTORY-586: bound the scan to THIS dialog's own frame. A `QUESTION`
    // line, an `OPTION` line, or an `Esc to cancel` footer all mark the edge
    // of some OTHER dialog sitting further up the scrollback — an earlier
    // one's question, its option list, or its footer. Past that edge, any
    // `╌` run belongs to that other frame, not to this one, so continuing
    // the scan would let an unrelated border (and the chatter above it)
    // become this dialog's body. Mirrors the no-separator MCP-tool arm's own
    // bounded header search above, which stops at a blank line, `SEPARATOR`,
    // or `QUESTION` for the identical reason — never cross into a different
    // dialog's frame to find an anchor for this one.
    if (QUESTION.test(line) || OPTION.test(line) || /Esc to cancel/.test(line)) break;
  }
  // FACTORY-583: when the opening border itself has scrolled off the visible
  // screen, or is beyond the other dialog's frame bounded above (FACTORY-586),
  // there is no anchor left for where the diff body actually starts — falling
  // back to line 0 (or past the boundary) would let `body` (and so
  // `promptId`) absorb whatever scrollback happens to sit above the closing
  // border, exactly the "promptId is a function of scrollback" bug this
  // ticket exists to close. The frame is genuinely gone, not merely hard to
  // find, so refuse rather than guess (FACTORY-396's lesson): return
  // undefined, meaning "not recognised yet", not "this isn't a prompt at
  // all".
  if (open < 0) return undefined;
  const body = lines.slice(open + 1, q - 1).map((line) => line.trim()).filter((line) => line !== "");
  if (body.length === 0) return undefined;
  // FACTORY-587: every diff body line carries the line-number gutter. A bare
  // stray `╌` run followed by plain chatter has none, so refuse it.
  if (!body.every((line) => DIFF_GUTTER.test(line))) return undefined;
  return { tool: match[1] === "create" ? "Create file" : "Edit file", request: body.join("\n") };
}

/** Claude's tool-permission dialog on a screen, or undefined for anything else. */
export function classifyPermissionPrompt(raw: string): PermissionPrompt | undefined {
  const lines = stripTerminalEscapes(raw).split(/\r?\n/);
  const q = lines.findIndex((line) => QUESTION.test(line));
  if (q < 0) return undefined;
  const question = QUESTION.exec(lines[q]!)![1]!;
  const options: string[] = [];
  let cursor = -1;
  let end = q + 1;
  let lastOptionNumber = -1;
  let blankRowTolerated = false;
  for (; end < lines.length; end++) {
    const line = lines[end]!;
    const match = OPTION.exec(line);
    if (match) {
      if (match[1]) cursor = options.length;
      lastOptionNumber = Number(match[2]);
      options.push(match[3]!);
      continue;
    }
    // A long option can wrap onto a following physical line with no number
    // of its own, indented like the measured wrap. Fold it back into the
    // option it continues rather than treating it as the end of the list —
    // otherwise the footer check below looks at the wrong window and the
    // whole dialog reads as "not a prompt", which is worse than unanswered:
    // it becomes invisible to listPendingPermissions entirely. A blank
    // line, an unindented stray line, a fresh separator or question, or the
    // footer itself still ends the list.
    if (line.trim() === "" && options.length > 0) {
      // FACTORY-603/604/605: the wrap above can itself leave a blank or
      // whitespace-only row INSIDE this option block — before its own
      // CONTINUATION row, after it, or between two numbered options — which
      // is otherwise indistinguishable from the footer's own trailing blank
      // line or from scrollback below a second, unrelated dialog. Decide
      // purely from THIS dialog's own content, never from screen position:
      // skip a bounded run of such rows (`MAX_OPTION_BLANK_RUN`), then
      // require the next non-blank row to either fold into the option
      // above it (a CONTINUATION row) or continue this block's own
      // numbering (an OPTION row numbered one past the last option
      // collected). A blank run followed by `1.` is a second dialog's own
      // block and fails that numbering check, ending the list exactly as
      // before this change — and so does the footer's own trailing blank
      // line, whose next non-blank row is `Esc to cancel`, neither a
      // CONTINUATION row nor an OPTION row.
      let probe = end;
      while (probe < lines.length && probe < end + MAX_OPTION_BLANK_RUN && lines[probe]!.trim() === "") probe++;
      const resumeLine = probe < lines.length ? lines[probe]! : undefined;
      if (resumeLine !== undefined) {
        // OPTION is checked first, exactly like the main loop above checks
        // it before CONTINUATION on the same line: `CONTINUATION` (any
        // indented, non-blank row) would otherwise also match an ordinary
        // numbered option line, misreading "   3. Yes, and …" as more text
        // folded onto option 2 instead of option 3 in its own right.
        const resumeMatch = OPTION.exec(resumeLine);
        if (resumeMatch) {
          if (Number(resumeMatch[2]) === lastOptionNumber + 1) {
            blankRowTolerated = true;
            end = probe - 1;
            continue;
          }
        } else {
          const resumeContinuation = CONTINUATION.test(resumeLine) && !SEPARATOR.test(resumeLine) && !QUESTION.test(resumeLine) && !/Esc to cancel/.test(resumeLine);
          if (resumeContinuation) {
            options[options.length - 1] = `${options[options.length - 1]} ${resumeLine.trim()}`;
            blankRowTolerated = true;
            end = probe;
            continue;
          }
        }
      }
      break;
    }
    const continuation = options.length > 0 && CONTINUATION.test(line) && !SEPARATOR.test(line) && !QUESTION.test(line) && !/Esc to cancel/.test(line);
    if (!continuation) break;
    options[options.length - 1] = `${options[options.length - 1]} ${line.trim()}`;
  }
  if (options.length < 2 || cursor < 0 || options[0] !== "Yes" || !options.some((option) => /^No\b/.test(option))) return undefined;
  const hasFooterLine = lines.slice(end, end + 3).some((line) => /Esc to cancel/.test(line));
  // WebFetch draws no `Esc to cancel` footer at all; its escape hint lives
  // inline in the "No, …" option's own text instead (FACTORY-365/6). Whether
  // that inline hint counts is decided below, once `request` is known — it
  // must be anchored to THIS shape's own body content (`WEBFETCH_BODY_MARKER`),
  // never to screen position: an earlier version of this fix required the
  // option list to be the last thing on screen, which broke on the ordinary
  // case of butchr's own notification chatter landing on a still-live pane
  // AFTER the dialog appeared (a routine real-fleet event, not hypothetical —
  // see FACTORY-356's measurement). Position also violates criterion 7
  // ("never screen position, line number, or distance from anywhere").
  const hasInlineEscHintOption = options.some((option) => INLINE_ESC_OPTION.test(option));
  if (!hasFooterLine && !hasInlineEscHintOption) return undefined;
  let separator = -1;
  for (let i = q - 1; i >= 0; i--) if (SEPARATOR.test(lines[i]!)) { separator = i; break; }
  let tool: string | undefined;
  let request: string;
  // What `promptId` hashes in place of `request` — identical to `request`
  // except on the no-separator Bash chrome below, where it deliberately
  // excludes the reason/warning line so promptId stays a function of the
  // command alone, never of which reason (if any) Claude renders that poll
  // (FACTORY-391: `request` itself DOES carry that line, for the audit trail).
  let promptIdRequest: string;
  let recognizedVia: PermissionPrompt["recognizedVia"];
  if (separator >= 0) {
    recognizedVia = "separator";
    const body = lines.slice(separator + 1, q).map((line) => line.trim()).filter((line) => line !== "" && !/^Tip:/.test(line));
    tool = body[0];
    if (tool === undefined) return undefined;
    request = body.slice(1).join("\n");
    promptIdRequest = request;
  } else {
    // Try the generic MCP-tool frame first (FACTORY-365/6): it draws no `─`
    // rule anywhere on screen, framing its body with `About the <server> —
    // <Tool> Tool:` and `(ctrl+o to expand description)` instead. Both must
    // be found, in an unbroken run of non-blank lines, or this isn't that
    // shape.
    let mcpTool: string | undefined;
    let expandLine = -1;
    for (let i = q - 1; i >= 0; i--) {
      if (MCP_EXPAND_HINT.test(lines[i]!)) { expandLine = i; break; }
      if (QUESTION.test(lines[i]!)) break;
    }
    // The measured shape has nothing but blank lines between the expand hint
    // and the question — anything else in that gap (narration, a fresh code
    // fence, more conversation) means this isn't the live frame, only text
    // that happens to contain its wording somewhere further up the scrollback.
    if (expandLine >= 0 && !lines.slice(expandLine + 1, q).every((line) => line.trim() === "")) expandLine = -1;
    let aboutLine = -1;
    if (expandLine >= 0) {
      for (let i = expandLine - 1; i >= 0; i--) {
        const line = lines[i]!;
        const match = MCP_ABOUT.exec(line);
        if (match) { aboutLine = i; mcpTool = match[1]; break; }
        if (line.trim() === "" || SEPARATOR.test(line) || QUESTION.test(line)) break;
      }
    }
    if (aboutLine >= 0 && mcpTool !== undefined) {
      recognizedVia = "no-separator-mcp-tool";
      tool = mcpTool;
      request = lines.slice(aboutLine + 1, q)
        .map((line) => line.replace(DESCRIPTION_LINE_PREFIX, "").trim())
        .filter((line) => line !== "" && !MCP_EXPAND_HINT.test(line))
        .join("\n");
      promptIdRequest = request;
    } else if (expandLine >= 0) {
      // FACTORY-396: the expand hint's own frame is present (only blank
      // lines between it and the question) but its `About the … Tool:`
      // header could not be found above it — most likely scrolled off the
      // visible screen too, on a long enough description. That hint line is
      // never a legitimate Bash dialog title on any known shape, so this is
      // decisively an (unrecognisable) MCP-tool frame, not a Bash dialog.
      // Falling through to the Bash arm below would let its title-scan
      // misread the hint line itself — or, once that's excluded, an
      // arbitrary description line still sitting directly above another
      // │-prefixed line — as `tool`, corrupting `promptId`. Refuse instead
      // of guessing; returning undefined here has the same effect as "we
      // don't recognise this specific screen (yet)", not "this isn't a
      // prompt at all" — a caller that reads again after the pane scrolls
      // further (or the description collapses) gets another chance.
      return undefined;
    } else {
      // Not the MCP-tool shape — try the newer Bash-dialog chrome (FACTORY-372),
      // a sibling fallback in this same no-separator arm, never a shared
      // implementation with the MCP-tool shape above. It also draws no `─`
      // rule at all. FACTORY-146 found (grepping the installed binary
      // directly, comment 26827 on FACTORY-359) that the line this fallback
      // used to hard-require there (`This command requires approval`) is
      // only ONE of a family of `reason` strings Claude renders in that same
      // slot — a too-complex security warning is another, and there are
      // more — as alternatives, never together. Keying recognition on that
      // text therefore missed the exact shape this ticket was filed about.
      // The anchor instead is the title line itself: the first non-blank
      // line, within a small bounded gap below the question, that sits
      // directly below the contiguous `│`-prefixed body run — whatever
      // reason (or nothing) occupies the gap is content, never the anchor.
      let titleLine = -1;
      let gapNonBlankLines = 0;
      for (let i = q - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (line.trim() === "") continue;
        if (i > 0 && BASH_BODY_LINE_PREFIX.test(lines[i - 1]!)) { titleLine = i; break; }
        if (++gapNonBlankLines > MAX_TITLE_GAP_LINES) break;
      }
      if (titleLine < 0) {
        // Not the Bash chrome either — try the file-edit/create diff shape
        // (FACTORY-460/580), a third sibling in this same no-separator arm.
        // A dialog taller than the pane scrolls its `─` rule AND its "Edit
        // file"/"Create file" title off screen, so neither the general arm
        // above nor the Bash sibling's title-scan has anything to find: the
        // body is a diff (bounded by `╌`, FACTORY-146's family of `│`-prefixed
        // reason text never applies here), not a `│`-prefixed run.
        const fileEdit = classifyFileEditNoSeparator(lines, q, question, options);
        if (fileEdit === undefined) return undefined;
        return makePermissionPrompt(fileEdit.tool, fileEdit.request, fileEdit.request, question, options, cursor, "no-separator-file-edit", blankRowTolerated);
      }
      recognizedVia = "no-separator-bash";
      tool = lines[titleLine]!.trim();
      // The body is the contiguous run of `│`-prefixed lines directly above
      // the title — nothing else. Stopping at the first non-`│` line, rather
      // than scanning further up, is what keeps `request` (and so `promptId`)
      // a function of the dialog's own frame and never of whatever scrollback
      // happens to sit above it.
      const bodyLines: string[] = [];
      for (let i = titleLine - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!BASH_BODY_LINE_PREFIX.test(line)) break;
        bodyLines.unshift(line.replace(BASH_BODY_LINE_PREFIX, "").trim());
      }
      // promptId is hashed from the command body alone (`promptIdRequest`),
      // never from the gap — that's what keeps it stable regardless of which
      // reason (if any) occupies the gap, the same invariant the bounded
      // MAX_TITLE_GAP_LINES scan above exists to protect during recognition
      // (FACTORY-391). `request`, returned for display/audit, additionally
      // carries the gap's own reason/warning text (e.g. a too-complex
      // command's `Contains brace with quote character (expansion
      // obfuscation)`, FACTORY-146 comment 26827) — dropping it there lost the
      // obfuscation signal the audit trail relied on before this chrome
      // existed, even though it rightly never fed the anchor or the hash.
      promptIdRequest = bodyLines.join("\n");
      const reasonLines = lines.slice(titleLine + 1, q).map((line) => line.trim()).filter((line) => line !== "");
      request = reasonLines.length > 0 ? `${promptIdRequest}\n${reasonLines.join("\n")}` : promptIdRequest;
    }
  }
  // The inline-`(esc)` hint alone is just verbatim option text, so a quoted
  // narration of this dialog — complete with its own separator line and the
  // same option wording — would otherwise be wrongly recognised (measured:
  // this exact ticket's own diagnosis quotes the WebFetch shape verbatim).
  // Anchor to the dialog's own body content instead of screen position:
  // WebFetch's body always carries "Claude wants to fetch content from
  // <host>" verbatim, which narration reproducing only the option text (not
  // the framed request body) won't have. Unlike a position check, this
  // survives real trailing chatter landing on a still-live pane.
  if (!hasFooterLine && hasInlineEscHintOption && !WEBFETCH_BODY_MARKER.test(request)) return undefined;
  return makePermissionPrompt(tool!, request, promptIdRequest, question, options, cursor, recognizedVia!, blankRowTolerated);
}

/**
 * `once` answers "Yes". `always` answers the "Yes, and …" option that
 * stores a rule; Claude words it "always allow … from this project", so it
 * outlives the session and is off unless a caller asks for it by name.
 */
export type PermissionScope = "once" | "always";

/**
 * Which option `scope` would press on `prompt`, or -1 when it offers none —
 * exported so a caller that only needs to know WHETHER a scope can answer a
 * prompt (`blocking-escalation.ts`'s escalation gap) never has to
 * re-implement this rule to ask the question without actually pressing
 * anything.
 */
export function optionFor(prompt: PermissionPrompt, scope: PermissionScope): number {
  // GUARD 8 (FACTORY-594/603/604/605, director decision 2026-10-02): a
  // prompt recognised ONLY because the option-collection loop had to skip a
  // blank row (`blankRowTolerated`) is answered at BOTH scopes — "once" AND
  // "always" — only when it is the read-only "Yes, allow reading from
  // <dir>" shape, exactly like its unwrapped twin already is. Every other
  // tolerated prompt (the "Yes, and don't ask again for: <command>" shape
  // included — an `rm -f` approval and a Claude Code "manual approval
  // required" warning among FACTORY-603's real captures) is
  // recognised-but-unanswerable at both scopes, routing to the existing
  // escalation path instead of being pressed: unwrapped behaviour for that
  // shape does not change at all, because this check only ever fires for a
  // prompt the blank-row tolerance itself made reachable. An earlier
  // version of this guard tried to carry the same intent by matching
  // `optionFor`'s "Yes, and …" result against the Bash "don't ask again"
  // wording — rejected on review: it only ever touched `scope: "always"`,
  // while the live caller's default is `scope: "once"` (which this guard
  // now also covers), and its own regex silently failed to match the real
  // captures' typographic apostrophe (U+2019, not ASCII). Keying on
  // `blankRowTolerated` instead sidesteps both defects: it needs no wording
  // match at all for the shapes it refuses, and it is scope-independent by
  // construction.
  if (prompt.blankRowTolerated) {
    const isReadOnlyAllow = prompt.tool === "Bash command" && prompt.options.some((option) => option.startsWith("Yes, allow reading from "));
    if (!isReadOnlyAllow) return -1;
    // Falls through: this shape's answer decision is exactly what the
    // normal logic below already gives its unwrapped twin (scope "once"
    // presses plain "Yes"; scope "always" finds no "Yes, and …" match,
    // since this label is "Yes, allow", never "Yes, and") — no separate
    // branch needed here to reproduce it.
  }
  if (scope === "once") {
    // GUARD 1 (FACTORY-580 ask/decision thread, FACTORY-584): an Edit/Create-
    // file dialog whose `path` could not be derived (no directory in option 2
    // — the in-trusted-root shape, the common case) must never be answered
    // blind. Completing it from the pane's own cwd was considered and
    // rejected: "inside the trusted root" means anywhere under it, the
    // question line carries only the basename, and cwd is what the pane
    // agent reports, not necessarily the trusted root — so a derived path
    // would really be a guess wearing a derived path's clothes, exactly what
    // this guard exists to forbid. Refusing BOTH scopes (not just "always",
    // which already refuses this shape unconditionally below) routes the
    // prompt into the existing FACTORY-318 escalation instead: it stays
    // recognised, but unanswerable, and a human decides.
    if ((prompt.tool === "Edit file" || prompt.tool === "Create file") && prompt.path === undefined) return -1;
    return prompt.options.indexOf("Yes");
  }
  // GUARD 1(b)/GUARD 4 (FACTORY-460/580): an Edit/Create-file dialog's own
  // "Yes, and …" option ALWAYS also switches the session to accept-edits
  // mode (auto-approving every future file edit), whether or not it also
  // grants a directory in the same breath — see `FILE_EDIT_OPTION_2` above.
  // `scope: "always"` must never press it for this shape, regardless of
  // what the caller asks for: the refusal lives here, inside drovr, rather
  // than depending on every caller passing `scope: "once"` on its own.
  // drovr's own default scope IS `"always"` (see `AutoAnswerPermissionsOptions.scope`),
  // so this is the only thing standing between that default and an
  // unattended pass auto-accepting every future edit.
  if (prompt.tool === "Edit file" || prompt.tool === "Create file") return -1;
  return prompt.options.findIndex((option) => /^Yes, and\b/.test(option) && !/auto mode/i.test(option));
}

function keysFor(prompt: PermissionPrompt, target: number): string[] {
  const step = target > prompt.cursor ? "down" : "up";
  return [...Array.from({ length: Math.abs(target - prompt.cursor) }, () => step), "enter"];
}

export interface PendingPermission extends PermissionPrompt {
  paneId: string;
  label: string | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
}

const readScreen = (client: ApprovalClient, paneId: string): Promise<string> =>
  client.agent.read({ target: paneId, source: "visible", strip_ansi: true }).then((read) => read.read.text);

export interface ScanPendingPermissionsOptions extends PaneReadDeadlineOptions {}

export interface ScanPendingPermissionsResult {
  pending: PendingPermission[];
  unreadable: UnreadablePane[];
}

/**
 * Every Claude pane showing a tool-permission prompt. Every Claude pane's
 * screen is read, not only those herdr marks blocked: a dialog herdr reports
 * as idle is exactly what Drovr exists to catch. Bounded by `readTimeoutMs`
 * (default 1500) per pane so one hung `agent.read` can't hold up the whole
 * scan — reads run in parallel, so the scan takes roughly the slowest read,
 * capped by the deadline. A pane whose screen cannot be read — it rejects,
 * or it never resolves within the deadline — is reported in `unreadable`,
 * never silently treated as "no pending prompt".
 */
export async function scanPendingPermissions(client: ApprovalClient, options: ScanPendingPermissionsOptions = {}): Promise<ScanPendingPermissionsResult> {
  const { agents } = await client.agent.list();
  const found = await Promise.all(agents.filter((agent) => agent.agent === "claude").map(async (agent) => {
    const base = {
      paneId: agent.pane_id,
      label: agent.name ?? undefined,
      sessionId: agent.agent_session?.kind === "id" ? agent.agent_session.value : undefined,
      cwd: agent.cwd ?? undefined,
      herdrStatus: agent.agent_status,
    };
    const read = await readPaneWithDeadline(client, agent.pane_id, options);
    if (read.kind !== "ok") return { unreadable: { ...base, reason: read.kind, detail: read.detail } };
    const prompt = classifyPermissionPrompt(read.screen);
    return prompt === undefined ? {} : { pending: { ...prompt, paneId: base.paneId, label: base.label, sessionId: base.sessionId, cwd: base.cwd } };
  }));
  return {
    pending: found.flatMap((r) => (r.pending ? [r.pending] : [])),
    unreadable: found.flatMap((r) => (r.unreadable ? [r.unreadable] : [])),
  };
}

/**
 * Every Claude pane showing a tool-permission prompt. A thin wrapper over
 * `scanPendingPermissions` that drops its `unreadable` list — a pane whose
 * screen could not be read is silently absent from the result, exactly as
 * before. Callers that need to tell "no pending prompt" apart from "could
 * not check" should call `scanPendingPermissions` directly.
 */
export async function listPendingPermissions(client: ApprovalClient): Promise<PendingPermission[]> {
  return (await scanPendingPermissions(client)).pending;
}

export interface ApprovePermissionRequest {
  paneId: string;
  /** The `promptId` the operator saw; a different prompt on screen is refused. */
  promptId: string;
  /** Who approved: recorded in the audit, never empty. */
  operator: string;
  scope?: PermissionScope;
  /** JSONL audit file; one record per attempt, and one more once keys were sent. */
  auditPath: string;
}

export type ApprovePermissionRefusalReason =
  | "invalid-operator"
  | "no-prompt"
  /** The screen shows a different prompt than the one the operator saw. */
  | "prompt-changed"
  | "option-missing"
  /** The audit record could not be written, so nothing was pressed. */
  | "audit-failed"
  /** Keys were sent but the same prompt is still on screen. */
  | "not-cleared"
  /** `sendKeys` itself threw. Whether a key reached the pane is unknown; never retried. */
  | "keys-failed"
  /** The verify loop threw after keys were sent (e.g. `deps.now`/`deps.wait`). Whether the prompt cleared is unknown; never retried. */
  | "verify-failed";

export type ApprovePermissionResult =
  | { ok: true; attemptId: string; tool: string; request: string; scope: PermissionScope; recognizedVia: PermissionPrompt["recognizedVia"] }
  | { ok: false; attemptId: string; reason: ApprovePermissionRefusalReason; detail: string };

export interface PermissionApprovalDeps {
  appendAudit(path: string, line: string): Promise<void>;
  now(): Date;
  wait(ms: number): Promise<void>;
  verifyTimeoutMs: number;
  pollMs: number;
}

/** Exported so `codex-permission-approval.ts` writes the same audit-timing/IO defaults to the same file. */
export const defaultDeps: PermissionApprovalDeps = {
  appendAudit: async (path, line) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, { mode: 0o600 });
  },
  now: () => new Date(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  verifyTimeoutMs: 5_000,
  pollMs: 250,
};

const AUDIT_REQUEST_CHARS = 500;

/**
 * Approve the prompt the operator saw, and only that prompt. The screen is
 * re-read first and a changed prompt is refused, so an approval can never land
 * on a prompt that appeared after the operator looked. An audit record is
 * written before any key is sent, and a second one with the outcome after.
 *
 * Once that `approving` record is written, nothing past this point escapes as
 * a throw: a `sendKeys` that rejects is `keys-failed`, and a verify-loop
 * throw (`deps.now`/`deps.wait`; `readScreen` failures are already caught) is
 * `verify-failed`. Both make a best-effort outcome `appendAudit` for the same
 * `attemptId` before returning `ok: false` — a failed write there is itself
 * swallowed (`.catch(() => undefined)`), so it never masks the result. Keys
 * are never retried either way.
 */
export async function approvePermission(
  client: ApprovalClient,
  request: ApprovePermissionRequest,
  overrides: Partial<PermissionApprovalDeps> = {},
): Promise<ApprovePermissionResult> {
  const deps = { ...defaultDeps, ...overrides };
  const attemptId = randomUUID();
  const scope = request.scope ?? "once";
  const agent = await client.agent.get(request.paneId).then((got) => got.agent, () => undefined);
  const record = (fields: Record<string, unknown>) => JSON.stringify({
    ts: deps.now().toISOString(),
    attemptId,
    operator: request.operator,
    paneId: request.paneId,
    label: agent?.name ?? undefined,
    sessionId: agent?.agent_session?.kind === "id" ? agent.agent_session.value : undefined,
    promptId: request.promptId,
    scope,
    ...fields,
  }) + "\n";
  const refuse = async (reason: ApprovePermissionRefusalReason, detail: string, prompt?: PermissionPrompt): Promise<ApprovePermissionResult> => {
    await deps.appendAudit(request.auditPath, record({
      outcome: reason, detail,
      ...(prompt ? { tool: prompt.tool, request: prompt.request.slice(0, AUDIT_REQUEST_CHARS) } : {}),
    })).catch(() => undefined);
    return { ok: false, attemptId, reason, detail };
  };

  if (!request.operator.trim()) return refuse("invalid-operator", "an approval must name its operator");
  const prompt = classifyPermissionPrompt(await readScreen(client, request.paneId).catch(() => ""));
  if (!prompt) return refuse("no-prompt", `pane ${request.paneId} shows no permission prompt`);
  if (prompt.promptId !== request.promptId) {
    return refuse("prompt-changed", `pane ${request.paneId} now shows a different prompt (${prompt.promptId}); list again and approve that one`, prompt);
  }
  const target = optionFor(prompt, scope);
  if (target < 0) return refuse("option-missing", `the prompt offers no option for scope ${scope}`, prompt);

  // GUARD 3 (FACTORY-460/580): `recognizedVia` on every record makes it
  // possible to grep this JSONL audit file specifically for auto-answers
  // that went through the new no-separator file-edit fallback —
  // `grep '"recognizedVia":"no-separator-file-edit"'` — distinct from every
  // other recognised shape, including the pre-existing SEPARATOR-arm
  // recognition of the same "Edit file"/"Create file" dialogs.
  const shown = { tool: prompt.tool, request: prompt.request.slice(0, AUDIT_REQUEST_CHARS), option: prompt.options[target], recognizedVia: prompt.recognizedVia };
  try {
    await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "approving" }));
  } catch (error) {
    return { ok: false, attemptId, reason: "audit-failed", detail: `audit not written, nothing pressed: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    await client.agent.sendKeys({ target: request.paneId, keys: keysFor(prompt, target) });
  } catch (error) {
    const detail = `whether a key may have reached the pane is unknown: ${error instanceof Error ? error.message : String(error)}`;
    await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "keys-failed", detail })).catch(() => undefined);
    return { ok: false, attemptId, reason: "keys-failed", detail };
  }

  try {
    const deadline = deps.now().getTime() + deps.verifyTimeoutMs;
    for (;;) {
      const still = classifyPermissionPrompt(await readScreen(client, request.paneId).catch(() => ""));
      if (still?.promptId !== request.promptId) {
        await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "approved" })).catch(() => undefined);
        return { ok: true, attemptId, tool: prompt.tool, request: prompt.request, scope, recognizedVia: prompt.recognizedVia };
      }
      if (deps.now().getTime() >= deadline) {
        await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "not-cleared" })).catch(() => undefined);
        return { ok: false, attemptId, reason: "not-cleared", detail: `keys were sent but pane ${request.paneId} still shows the prompt` };
      }
      await deps.wait(deps.pollMs);
    }
  } catch (error) {
    const detail = `keys were sent but whether pane ${request.paneId} shows the prompt is unknown: ${error instanceof Error ? error.message : String(error)}`;
    await deps.appendAudit(request.auditPath, record({ ...shown, outcome: "verify-failed", detail })).catch(() => undefined);
    return { ok: false, attemptId, reason: "verify-failed", detail };
  }
}

export interface AutoAnswerPermissionsOptions {
  /** JSONL audit file, forwarded to every `approvePermission` call. */
  auditPath: string;
  /** Recorded as the audit operator on every attempt. Default lets an unattended pass be told apart from a human's. */
  operator?: string;
  /**
   * Deadline for the whole per-pane `approvePermission` attempt (not a single
   * read). A pane past it is `failed` with `reason: "timeout"`, never left
   * out of the results — but `approvePermission` is not cancelled, so a
   * `timeout` result means the outcome is UNKNOWN, not "nothing pressed":
   * the call keeps running and may still press keys and record `approved` in
   * the audit log after this function has already returned. Check the audit
   * log for a pane that timed out.
   */
  readTimeoutMs?: number;
  /**
   * Which option an unattended pass presses (FACTORY-93). `"always"` (the
   * default, unchanged) presses option 2 only when it is the "Yes, and …"
   * stored-rule option. `"once"` presses option 1 only when it is exactly
   * "Yes" — no stored rule, and no dependence on how Claude words its
   * "always allow" option (the read-permission dialog says "Yes, allow reading
   * … from this project", which `"always"` never recognised and skipped).
   */
  scope?: PermissionScope;
}

interface AutoAnswerBase {
  paneId: string;
  label: string | undefined;
}

export type AutoAnswerPermissionResult =
  | (AutoAnswerBase & { outcome: "answered"; tool: string; request: string; recognizedVia: PermissionPrompt["recognizedVia"] })
  | (AutoAnswerBase & { outcome: "skipped"; reason: string })
  | (AutoAnswerBase & { outcome: "failed"; reason: string; detail: string });

const DEFAULT_AUTO_OPERATOR = "drovr-auto";
const AUTO_ANSWER_TIMEOUT = Symbol("auto-answer-timeout");

/**
 * One unattended pass over every pending Claude permission prompt: press the
 * option for `options.scope` and nothing else — with `"always"` (default),
 * option 2 when it is the "Yes, and …" stored-rule option; with `"once"`,
 * option 1 when it is exactly "Yes". A prompt without that option in that
 * position is skipped (with a `reason`) before `approvePermission` is ever
 * called, so no "approving" audit record is written for it. One pane throwing, or (with `readTimeoutMs` set)
 * missing its deadline, is caught and reported as `failed` for that pane; it
 * never fails the rest of the pass. A `timeout` failure does not mean nothing
 * was pressed — see `AutoAnswerPermissionsOptions.readTimeoutMs`.
 */
export async function autoAnswerPermissions(
  client: ApprovalClient,
  options: AutoAnswerPermissionsOptions,
): Promise<AutoAnswerPermissionResult[]> {
  const operator = options.operator ?? DEFAULT_AUTO_OPERATOR;
  const pending = await listPendingPermissions(client);
  return Promise.all(pending.map(async (permission): Promise<AutoAnswerPermissionResult> => {
    const base = { paneId: permission.paneId, label: permission.label };
    try {
      const scope = options.scope ?? "always";
      const target = optionFor(permission, scope);
      if (scope === "once" && target !== 0) {
        return { ...base, outcome: "skipped", reason: target < 0
          ? `no plain "Yes" option on this prompt (options: ${JSON.stringify(permission.options)})`
          : `"Yes" is at position ${target + 1}, not option 1 (options: ${JSON.stringify(permission.options)})` };
      }
      if (scope === "always" && target !== 1) {
        return { ...base, outcome: "skipped", reason: target < 0
          ? `no "Yes, and …" stored-rule option on this prompt (options: ${JSON.stringify(permission.options)})`
          : `the stored-rule option is at position ${target + 1}, not option 2 (options: ${JSON.stringify(permission.options)})` };
      }
      const attempt = approvePermission(client, {
        paneId: permission.paneId,
        promptId: permission.promptId,
        operator,
        scope,
        auditPath: options.auditPath,
      });
      attempt.catch(() => undefined);
      let result: ApprovePermissionResult | typeof AUTO_ANSWER_TIMEOUT;
      if (options.readTimeoutMs === undefined) {
        result = await attempt;
      } else {
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<typeof AUTO_ANSWER_TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(AUTO_ANSWER_TIMEOUT), options.readTimeoutMs);
        });
        try {
          result = await Promise.race([attempt, deadline]);
        } finally {
          clearTimeout(timer!);
        }
      }
      if (result === AUTO_ANSWER_TIMEOUT) {
        return {
          ...base, outcome: "failed", reason: "timeout",
          detail: `approvePermission did not return within ${options.readTimeoutMs}ms; it is still running and the outcome is unknown — it may still press keys and record "approved" in the audit log, check it before retrying this pane`,
        };
      }
      if (result.ok) return { ...base, outcome: "answered", tool: result.tool, request: result.request, recognizedVia: result.recognizedVia };
      if (
        result.reason === "audit-failed" || result.reason === "not-cleared" || result.reason === "invalid-operator" ||
        result.reason === "keys-failed" || result.reason === "verify-failed"
      ) {
        return { ...base, outcome: "failed", reason: result.reason, detail: result.detail };
      }
      return { ...base, outcome: "skipped", reason: result.detail };
    } catch (error) {
      return { ...base, outcome: "failed", reason: "unexpected-error", detail: error instanceof Error ? error.message : String(error) };
    }
  }));
}
