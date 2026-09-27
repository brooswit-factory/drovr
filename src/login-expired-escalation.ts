import { createHash } from "node:crypto";
import type { DrovrClient } from "./drovr-client.js";
import { classifyClaudeTranscriptRecord } from "./blocking-conditions.js";
import { readClaudeTranscriptTail, type ClaudeTranscriptTail } from "./native-transcript.js";

/**
 * The login-expired condition (FACTORY-360/FACTORY-357): Claude Code's OWN
 * OAuth session expiring mid-fleet. Unlike every other condition in
 * `blocking-escalation.ts`, this one is deliberately NOT detected from the
 * pane's screen at all.
 *
 * Measured on the incident host (FACTORY-357 comment 26492): the authentic
 * `Login expired · Please run /login` string sat byte-identical in a
 * completely healthy pane's scrollback for 41+ minutes after the condition
 * had cleared, while that pane was successfully answering tool-permission
 * prompts in the same second. No regex over screen text — however careful —
 * can tell that apart from a live failure, because the text genuinely is
 * identical; it is only old. `classifyBlockingScreen`'s footer gate
 * (`blocking-prompts.ts`) also structurally cannot see this condition at
 * all: a login-expired pane draws no dialog and so no footer.
 *
 * The authority here is instead the pane's own Claude transcript, via the
 * structural tag `classifyClaudeTranscriptRecord` already reads
 * (`type: "assistant"`, `isApiErrorMessage: true`,
 * `error: "authentication_failed"`), combined with a RECENCY rule: the
 * failure must be the pane's LATEST relevant turn. A later successful
 * (non-error) assistant turn is proof the API call succeeded again, which
 * means the condition cleared — screen text plays no part in that decision.
 * This module never reads a pane's screen at all, so a stale screen (the
 * measured false-positive above) cannot influence it even as a pre-filter.
 */

/** A transcript record's own stable field, used to derive a per-episode identity. Never a screen position or excerpt. */
function anchorOf(record: Record<string, unknown>): string | undefined {
  if (typeof record.uuid === "string" && record.uuid) return record.uuid;
  if (typeof record.timestamp === "string" && record.timestamp) return record.timestamp;
  return undefined;
}

/**
 * A content hash of the failing record's own stable anchor (`uuid`, else
 * `timestamp` — both assigned once by Claude Code when the record is
 * written, never recomputed from scrollback or line position). FACTORY-357
 * measured (comment 26612, citing FACTORY-146/FACTORY-356) that an id built
 * from anything position- or excerpt-dependent drifts as chatter
 * accumulates around it — the SAME dialog produced four different
 * fingerprints as 0/3/9/20 unrelated lines were prepended. An anchor field
 * is immune to that by construction: prepending unrelated transcript
 * records ahead of the real failure record never changes the failure
 * record's own `uuid`/`timestamp`. See the `test("episode identity is
 * stable...")` case for the N = 0/3/9/20 proof.
 */
function episodeIdOf(anchor: string): string {
  return createHash("sha256").update(`login-expired:${anchor}`).digest("hex").slice(0, 16);
}

interface RecencyEvidence {
  live: boolean;
  detail?: string;
  episodeId?: string;
}

/**
 * Walk transcript records IN ORDER and return the state implied by the last
 * relevant one — `undefined` when this batch of records contains no
 * relevant evidence at all (neither a login-expired failure nor a genuine
 * successful completion), so a caller knows to carry forward whatever it
 * already believed rather than resetting to "not live".
 *
 * "Relevant" is deliberately narrow: only `type: "assistant"` records.
 * - A record `classifyClaudeTranscriptRecord` recognises as the structural
 *   login-expired tag is a failure — but only if it carries a stable anchor
 *   (see `anchorOf`); a record missing both `uuid` and `timestamp` cannot
 *   support a stable episode identity and is treated as absent evidence
 *   rather than shipped with an unstable one (FACTORY-357 comment 26612:
 *   "an unstable identity is worse than no identity").
 * - Any OTHER `isApiErrorMessage: true` record (a non-auth API error, e.g.
 *   a rate limit) proves nothing about login state either way and is
 *   skipped.
 * - Every other assistant record is a genuine, non-error completion: proof
 *   the API call succeeded, which is the real "cleared" signal — not the
 *   mere absence of the failure string, and not a tool result (a tool can
 *   execute locally without a live model call, so it does not by itself
 *   prove the session recovered).
 *
 * A `user` record — including one that merely QUOTES the login-expired text
 * in narration or a pasted ticket comment — is never inspected for its
 * text content and can never flip this either way: recognition is
 * structural-tag-only, per `classifyClaudeTranscriptRecord`.
 */
export function deriveLoginExpiredCondition(records: readonly unknown[]): RecencyEvidence | undefined {
  let evidence: RecencyEvidence | undefined;
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (record.type !== "assistant") continue;
    const failure = classifyClaudeTranscriptRecord(record);
    if (failure) {
      const anchor = anchorOf(record);
      if (anchor === undefined) continue; // cannot anchor a stable episode; not usable evidence
      evidence = { live: true, detail: failure.detail, episodeId: episodeIdOf(anchor) };
      continue;
    }
    if (record.isApiErrorMessage === true) continue; // a different API error: neither confirms nor clears login
    evidence = { live: false }; // a real completion: the session is alive
  }
  return evidence;
}

/** Everything a host needs to escalate a login-expired pane, with no answer affordance. */
export interface LoginExpiredEscalation {
  paneId: string;
  label: string | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
  /** herdr's own status, carried alongside because herdr often calls this pane done, not blocked. */
  herdrStatus: string;
  kind: "login-expired";
  /** The matched transcript text, verbatim. Not a screen excerpt. */
  detail: string;
  /**
   * Stable across polls of the SAME episode (see `episodeIdOf`); a NEW
   * failure (a different transcript record) gets a different id. This is
   * NOT a fingerprint/token a host can echo back as an answer — there is no
   * `ANSWER` protocol for an expired OAuth token, only a human doing a real
   * browser re-login. Never document or wire this as answerable.
   */
   episodeId: string;
}

/**
 * Why THIS episode resolved — a closed union a host can exhaustively switch
 * on, never a loose string:
 * - `"recovered"`: a later genuine (non-error) transcript turn proved the
 *   credential itself works again. The ONLY reason a host should read as
 *   "the credential is back" — see `docs/blocking-escalation.md`'s
 *   host-wide section for why the other two reasons must not be read that
 *   way.
 * - `"pane-gone"`: the pane vanished from `agent.list()` entirely (closed).
 *   There is no pane left to page about, but this says NOTHING about
 *   whether the credential recovered — panes churn (a daemon respawn, the
 *   reconciler tearing down and replacing a pane) while the credential can
 *   still be completely dead.
 * - `"superseded"`: a NEW failure record replaced this episode on the SAME
 *   still-live pane before this one ever saw a genuine completion (the
 *   ordinary shape of a dead credential being retried: consecutive
 *   `authentication_failed` records with nothing successful between them).
 *   The credential did NOT recover — a new `onLoginExpired` for the
 *   replacement episode fires on this same pane immediately after. Without
 *   this reason a host would have to fall back to guessing "recovered" or
 *   "pane-gone" for a resolve that is neither, and "recovered" is exactly
 *   the wrong guess: it is the same false-recovery-signal danger this
 *   discriminator exists to prevent, just occurring one episode later than
 *   the shortcut this ticket also removes from the docs.
 */
export type LoginExpiredResolvedReason = "recovered" | "pane-gone" | "superseded";

export interface LoginExpiredResolved {
  paneId: string;
  episodeId: string;
  reason: LoginExpiredResolvedReason;
}

/**
 * A host-neutral hook, deliberately NOT `BlockingEscalationHook`'s shape:
 * no `question`, no `options`, nothing a host could mistake for something
 * to answer. `onLoginExpiredResolved` fires once the recency rule sees a
 * later successful turn — never on a guess, and never merely because the
 * screen no longer shows the string (this module never reads the screen).
 */
export interface LoginExpiredEscalationHook {
  onLoginExpired(escalation: LoginExpiredEscalation): void | Promise<void>;
  onLoginExpiredResolved(resolved: LoginExpiredResolved): void | Promise<void>;
}

export type LoginExpiredOutcome =
  | { paneId: string; outcome: "escalated"; episodeId: string }
  | { paneId: string; outcome: "resolved"; episodeId: string }
  | { paneId: string; outcome: "unreadable"; reason: string }
  | { paneId: string; outcome: "hook-failed"; phase: "escalate" | "resolve"; detail: string };

type LoginExpiredScanClient = { agent: Pick<DrovrClient["agent"], "list"> };

/** Injectable so a test never touches the real filesystem; defaults to a live Claude session's own transcript. */
export interface LoginExpiredWatcherDeps {
  readTranscriptTail(session: { sessionId: string; cwd: string }, offset: number): Promise<ClaudeTranscriptTail>;
}

const defaultDeps: LoginExpiredWatcherDeps = {
  readTranscriptTail: (session, offset) => readClaudeTranscriptTail(session, offset),
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface PaneState {
  sessionId: string;
  cwd: string;
  offset: number;
  /** The condition as of the last record that carried evidence; `undefined` once a real completion clears it. */
  live: { episodeId: string; detail: string } | undefined;
  /** The episodeId already reported to the hook, or `undefined` if nothing is currently escalated for this pane. */
  escalated: string | undefined;
}

export interface LoginExpiredWatcher {
  /** One pass over every Claude pane's transcript. Never call concurrently on the same watcher — two overlapping polls would race the same per-pane state. */
  poll(client: LoginExpiredScanClient): Promise<LoginExpiredOutcome[]>;
}

/**
 * A host-neutral watcher for the login-expired condition, parallel to (but
 * deliberately separate from) `createBlockingEscalationWatcher`: that
 * watcher's whole shape is screen-based (`scanBlockingPrompts` reads a
 * pane's screen, `classifyBlockingScreen` classifies it synchronously), and
 * this condition's authority is the opposite — the transcript, read
 * incrementally from disk, async, with no screen read anywhere in the path.
 * Forcing this into `classifyBlockingScreen`/`scanBlockingPrompts` would
 * mean deciding the condition from the one input (screen text) FACTORY-357
 * measured is structurally unable to decide it; this watcher instead reads
 * every Claude pane's transcript directly (`agent.list()` for identity,
 * then `readClaudeTranscriptTail` per pane) and never calls `agent.read` or
 * `agent.sendKeys` at all — so it is structurally incapable of pressing a
 * key on a login-expired pane, not merely disciplined not to.
 *
 * Per-pane episode state (the current live/cleared verdict, the escalated
 * episode id, and the transcript read offset) lives in this watcher's own
 * closure across polls, exactly like `createBlockingEscalationWatcher`'s
 * `open` map — never in Drovr's exports, never in a host's own ticket
 * system.
 */
export function createLoginExpiredWatcher(hook: LoginExpiredEscalationHook, deps: LoginExpiredWatcherDeps = defaultDeps): LoginExpiredWatcher {
  const panes = new Map<string, PaneState>();

  async function resolvePane(paneId: string, state: PaneState, outcomes: LoginExpiredOutcome[], reason: LoginExpiredResolvedReason): Promise<void> {
    if (state.escalated === undefined) return;
    const episodeId = state.escalated;
    try {
      await hook.onLoginExpiredResolved({ paneId, episodeId, reason });
      state.escalated = undefined;
      outcomes.push({ paneId, outcome: "resolved", episodeId });
    } catch (error) {
      outcomes.push({ paneId, outcome: "hook-failed", phase: "resolve", detail: message(error) });
    }
  }

  return {
    async poll(client) {
      const { agents } = await client.agent.list();
      const outcomes: LoginExpiredOutcome[] = [];
      const seen = new Set<string>();

      for (const agent of agents) {
        if (agent.agent !== "claude") continue;
        const paneId = agent.pane_id;
        seen.add(paneId);
        const sessionId = agent.agent_session?.kind === "id" ? agent.agent_session.value : undefined;
        const cwd = agent.cwd ?? undefined;

        if (sessionId === undefined || cwd === undefined) {
          // No native session identity to read a transcript from at all.
          // Never resolve an open episode on this guess — mirrors
          // scanBlockingPrompts's "unreadable leaves state open" discipline.
          outcomes.push({ paneId, outcome: "unreadable", reason: "no native session identity" });
          continue;
        }

        let state = panes.get(paneId);
        if (!state || state.sessionId !== sessionId || state.cwd !== cwd) {
          state = { sessionId, cwd, offset: 0, live: undefined, escalated: undefined };
          panes.set(paneId, state);
        }

        let tail: ClaudeTranscriptTail;
        try {
          tail = await deps.readTranscriptTail({ sessionId, cwd }, state.offset);
        } catch (error) {
          outcomes.push({ paneId, outcome: "unreadable", reason: message(error) });
          continue;
        }
        state.offset = tail.offset;

        const records = tail.text.split("\n").filter((line) => line.length > 0).flatMap((line) => {
          try { return [JSON.parse(line) as unknown]; } catch { return []; }
        });
        const evidence = records.length ? deriveLoginExpiredCondition(records) : undefined;
        if (evidence !== undefined) {
          state.live = evidence.live ? { episodeId: evidence.episodeId!, detail: evidence.detail! } : undefined;
        }

        if (state.live && state.escalated !== state.live.episodeId) {
          // A DIFFERENT episode was already open on this pane (a dead
          // credential being retried produces consecutive failure records
          // with no successful completion between them — the ordinary
          // shape, not a rarity): resolve it before treating the new one as
          // live, mirroring createBlockingEscalationWatcher's closeIfOpen.
          // Otherwise every retry would leak a permanently-open episode and
          // one dead credential would emit an unbounded "new episode"
          // stream instead of escalated/resolved staying balanced.
          await resolvePane(paneId, state, outcomes, "superseded");
          const { episodeId, detail } = state.live;
          try {
            await hook.onLoginExpired({
              paneId, label: agent.name ?? undefined, sessionId, cwd, herdrStatus: agent.agent_status,
              kind: "login-expired", detail, episodeId,
            });
            state.escalated = episodeId;
            outcomes.push({ paneId, outcome: "escalated", episodeId });
          } catch (error) {
            outcomes.push({ paneId, outcome: "hook-failed", phase: "escalate", detail: message(error) });
          }
        } else if (!state.live) {
          await resolvePane(paneId, state, outcomes, "recovered");
        }
      }

      // A pane that vanished from agent.list() entirely (closed) with an open
      // episode: resolve it — there is no pane left to page about.
      for (const [paneId, state] of panes) {
        if (!seen.has(paneId)) {
          await resolvePane(paneId, state, outcomes, "pane-gone");
          panes.delete(paneId);
        }
      }

      return outcomes;
    },
  };
}
