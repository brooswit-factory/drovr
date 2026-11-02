/**
 * KNOWN, BOUNDED RESIDUAL RISK (BUTCHR-259 review, comment 19465) — recorded
 * here rather than left implicit, per AC4's own standard that a mechanism's
 * limits must be legible, not just its successes:
 *
 * A tool result whose OWN output is, byte-for-byte, a genuine banner's
 * `⎿`-prefixed line immediately paired with its real wrap continuation
 * (`/upgrade`/`/usage-credits`), at margin depth 2, with nothing after it
 * that this module's guards recognise as disqualifying, IS indistinguishable
 * from a live refusal — and is currently recognised as one. Concretely: an
 * agent running `grep -A1 "hit your session limit" <a real capture file>`
 * (or `cat`/`Read` on any source that already contains those exact bytes)
 * produces exactly this shape. Verified directly against this
 * implementation, not theorised.
 *
 * Two candidate guards were tried and both FALSIFIED against real data
 * before concluding this can't be closed from pane text alone:
 *   - "reject a ⎿ line preceded by a tool-invocation line" — falsified by a
 *     genuine capture (BUTCHR-115) whose real banner is immediately preceded
 *     by "  Called butchr" with no invocation glyph: a session-limit
 *     failure can occur mid-turn, on what looks like a tool call, not only
 *     on the initial prompt — this would reject real banners too.
 *   - "require the pane's own last line to BE composer chrome" — doesn't
 *     discriminate: a faithfully-built adversarial pane is ALSO idle and
 *     ALSO ends in real composer chrome (the composer is unconditional
 *     idle-pane UI, not evidence either way about what produced the lines
 *     above it).
 *
 * Claude Code's rendering does not distinguish, in the text it prints,
 * between "the model's own turn was replaced with this refusal string" and
 * "a tool's actual output happens to equal this string" — both are an
 * identical `⎿`-headed, paired, chrome-terminated block. No further
 * structural signal is available to split them.
 *
 * Mitigations, not closures:
 *   - The poller's own `agent_status` idle/done gate (session-limit-watch.ts)
 *     still applies: the pane must have actually finished a turn in exactly
 *     this shape, not merely be mid-command.
 *   - Reproducing the exact bytes (real `⎿` + NBSP) requires the SOURCE data
 *     already contain them verbatim — in practice, a real pane capture file
 *     or this repo's own fixtures/docs. The exposure is narrow and largely
 *     confined to agents working this epic, not the general fleet.
 *
 * What would close it: a signal at the SOURCE (herdr's `pane.read`, or
 * Claude Code itself) distinguishing a genuine API-refusal substitution
 * from ordinary tool-result text — e.g. structured output that tags which
 * segments are model-generated versus tool-returned, rather than the
 * flattened ANSI-stripped string this module receives today. Not available
 * currently; not implemented here.
 */
/** A recognised Claude Code session-limit refusal, parsed from ANSI-stripped pane text. */
export interface SessionLimitRefusal {
    /**
     * Next epoch ms at/after `now` when the printed reset clock time occurs, or
     * null if the refusal was recognised but no reset time could be parsed —
     * conservative by construction: never invented, only reported absent so an
     * operator can see recovery cannot be scheduled.
     */
    resetsAt: number | null;
    /** The matched refusal line, verbatim, for logging. */
    raw: string;
}
/**
 * The full outcome of classifying a pane's text, distinguishing three cases
 * that a bare `null` collapses into one (BUTCHR-259 AC4 — the whole epic
 * exists because a mechanism that did nothing looked identical to one that
 * was working):
 *
 * - `recognised`: a genuine, currently-live refusal — schedule recovery.
 * - `suppressed`: a refusal-SHAPED, `⎿`-prefixed line was found, but a
 *   structural signal says it is quoted/embedded text (a rendered ticket or
 *   comment body, e.g. KAN-804/807) rather than the pane's own live tool
 *   result. `reason` always says which signal fired — a silent suppression
 *   is exactly the defect this ticket exists to close, restated.
 * - `not-recognised`: no refusal-shaped line found at all (including a bare,
 *   non-`⎿` line outside the legacy TAIL_LINES budget — see below).
 */
export type SessionLimitOutcome = {
    kind: "recognised";
    resetsAt: number | null;
    raw: string;
} | {
    kind: "suppressed";
    raw: string;
    reason: string;
} | {
    kind: "not-recognised";
};
/**
 * Recognise the "You've hit your session limit" refusal in ANSI-stripped
 * pane text and, if present, resolve the printed reset clock time to the
 * next occurrence at or after `now` (treated as LOCAL time — a 9:50pm reset
 * seen at 6:59pm is tonight; seen at 11pm it is tomorrow). `now` is
 * injected: this module does no I/O and never reaches for the clock itself.
 *
 * Collapses `classifySessionLimitText`'s `suppressed` and `not-recognised`
 * outcomes to `null` — both are correctly "not a live refusal right now"
 * for every existing caller (herd.ts's kickoff-verify/nudge gates), which
 * must not treat quoted/embedded text as blocking either. Use
 * `classifySessionLimitText` directly where the distinction (and the
 * suppression reason) matters for logging — see session-limit-watch.ts.
 */
export declare function detectSessionLimitRefusal(text: string, now: Date): SessionLimitRefusal | null;
/**
 * The detailed classification behind `detectSessionLimitRefusal`. Two
 * independent paths, tried in this order:
 *
 * 1. `⎿`-prefixed candidates (how every real banner renders): scan the
 *    WHOLE text for the MOST RECENT (closest to the end) line that, once
 *    the tool-result prefix is stripped, matches REFUSAL_LINE — not
 *    position-bounded, because BUTCHR-259 measured genuine banners sitting
 *    anywhere from content-depth 5 to 25 depending on incidental chrome
 *    (including arbitrary async notification boxes). Only the MOST RECENT
 *    such line is ever considered: an older occurrence further back is a
 *    past attempt, not current pane state — and if the agent has run
 *    anything at all since (proven by there being real content between the
 *    two), the session cannot still be the one that's refused. Once found,
 *    it is decided immediately, live or suppressed — earlier occurrences
 *    are never consulted as a fallback.
 *
 *    Decided live only if BOTH:
 *      (a) the very next raw line matches the banner's own known wrap
 *          continuation (BANNER_CONTINUATION) — the primary guard, and
 *      (b) nothing looks like FURTHER embedded content after that
 *          continuation (embeddedAfter) — a defense-in-depth guard against
 *          the worst case where an adversarial quote reproduces the full
 *          two-line pair verbatim and then keeps going (more ticket prose,
 *          a `… +N lines (ctrl+o to expand)` truncation tail).
 *    Anything else on this path is `suppressed`, with a reason.
 *
 * 2. Legacy bare-line path (see TAIL_LINES): only reached if no `⎿`-
 *    prefixed candidate was found at all. Unchanged in behaviour from
 *    before BUTCHR-259.
 */
export declare function classifySessionLimitText(text: string, now: Date): SessionLimitOutcome;
