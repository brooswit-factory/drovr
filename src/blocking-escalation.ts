import { createHash } from "node:crypto";
import type { DrovrClient } from "./drovr-client.js";
import { scanBlockingPrompts, type BlockingPrompt, type ScanBlockingPromptsOptions, type UnreadablePane } from "./blocking-prompts.js";

/**
 * The general mechanism: Drovr detects any dialog blocking a Claude pane,
 * answers the ones it knows are safe, and for everything else calls a
 * host-neutral hook instead of keeping a dialog list of its own. The host
 * (Butchr, or any other consumer) supplies the hook and decides what
 * escalation means for it — a Jira comment, a workspace note, a channel
 * message — without Drovr ever knowing which.
 */

type EscalationClient = { agent: Pick<DrovrClient["agent"], "list" | "read" | "sendKeys"> };

/**
 * Everything a host needs to escalate a dialog Drovr does not know how to
 * answer, with no issue key required. `cwd` is Drovr's own identity for a
 * pane that may have none of its own (a managed session is named only by
 * its definition path, never a Jira/GitHub/Zendesk key) — verify it against
 * your own workspace layout before trusting it as a filesystem path; Drovr
 * only forwards what herdr reports. `question`/`options` are copied
 * verbatim from the screen, never paraphrased. `fingerprint` is stable
 * across polls of the SAME dialog (content-based: it does not change while
 * a cursor merely moves), so a host escalates one episode once, not every
 * poll.
 */
export interface UnknownDialogEscalation {
  paneId: string;
  label: string | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
  /** herdr's own status, carried alongside because herdr often calls a blocked pane idle. */
  herdrStatus: string;
  question: string;
  options: string[];
  fingerprint: string;
}

export interface DialogResolved {
  paneId: string;
  fingerprint: string;
}

/**
 * A host-neutral escalation hook. Drovr calls it and knows nothing about
 * what happens next. Either callback may be async; a rejection is caught
 * per-pane (see `AutoHandleOutcome`'s `hook-failed`) and never fails the
 * rest of a poll.
 */
export interface BlockingEscalationHook {
  onUnknownDialog(escalation: UnknownDialogEscalation): void | Promise<void>;
  onDialogResolved(resolved: DialogResolved): void | Promise<void>;
}

export type AutoHandleOutcome =
  /** A known-safe startup prompt was pressed (trust, development-channels, auto-mode-onboarding, fullscreen-renderer). */
  | { paneId: string; outcome: "answered"; name: string }
  /** Recognised but deliberately left unanswered here: an MCP-approval startup prompt, or a tool-permission prompt — both keep their own existing flow. */
  | { paneId: string; outcome: "reported"; kind: BlockingPrompt["kind"]; name: string | undefined }
  /** A new (pane, fingerprint) episode; `hook.onUnknownDialog` succeeded. */
  | { paneId: string; outcome: "escalated"; fingerprint: string }
  /** An open episode's dialog is no longer on screen with the same fingerprint; `hook.onDialogResolved` succeeded. */
  | { paneId: string; outcome: "resolved"; fingerprint: string }
  /** A pane's screen could not be read this poll; any open episode on it is left open, never resolved on a guess. */
  | { paneId: string; outcome: "unreadable"; reason: UnreadablePane["reason"] }
  | { paneId: string; outcome: "hook-failed"; phase: "escalate" | "resolve"; detail: string };

export interface BlockingEscalationWatcher {
  /**
   * One pass over every Claude pane. Never call this concurrently on the
   * same watcher — two overlapping polls would race the same open-episode
   * state kept inside it.
   */
  poll(client: EscalationClient, options?: ScanBlockingPromptsOptions): Promise<AutoHandleOutcome[]>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const fingerprintOf = (question: string, options: string[]): string =>
  createHash("sha256").update(JSON.stringify([question, options])).digest("hex").slice(0, 16);

/**
 * A host-neutral escalation watcher. It carries (pane, fingerprint) episode
 * state across polls in its own closure — never in Drovr's exports, never
 * in the host's ticket system — so `hook.onUnknownDialog` fires exactly
 * once per episode and `hook.onDialogResolved` fires exactly once when that
 * same episode's dialog clears (the pane answers it, the pane closes, or a
 * different dialog — a new fingerprint — replaces it).
 */
export function createBlockingEscalationWatcher(hook: BlockingEscalationHook): BlockingEscalationWatcher {
  const open = new Map<string, string>(); // paneId -> fingerprint of the open episode

  async function closeIfOpen(paneId: string, outcomes: AutoHandleOutcome[]): Promise<void> {
    const fingerprint = open.get(paneId);
    if (fingerprint === undefined) return;
    open.delete(paneId);
    try {
      await hook.onDialogResolved({ paneId, fingerprint });
      outcomes.push({ paneId, outcome: "resolved", fingerprint });
    } catch (error) {
      outcomes.push({ paneId, outcome: "hook-failed", phase: "resolve", detail: message(error) });
    }
  }

  return {
    async poll(client, options) {
      const { prompts, unreadable } = await scanBlockingPrompts(client, options);
      const outcomes: AutoHandleOutcome[] = [];
      const seenPanes = new Set<string>();

      for (const prompt of prompts) {
        seenPanes.add(prompt.paneId);

        if (prompt.kind === "startup" && prompt.keys) {
          await client.agent.sendKeys({ target: prompt.paneId, keys: prompt.keys }).catch(() => undefined);
          outcomes.push({ paneId: prompt.paneId, outcome: "answered", name: prompt.name! });
          await closeIfOpen(prompt.paneId, outcomes);
          continue;
        }
        if (prompt.kind !== "unknown" || !prompt.dialog) {
          // Recognised-but-unanswered (mcp-approval, permission), or truly
          // unknown but not readable with confidence: reported, never
          // guessed at. `describeUnknownDialog` already refused a payload
          // it could not verify — this path must not invent one either.
          outcomes.push({ paneId: prompt.paneId, outcome: "reported", kind: prompt.kind, name: prompt.name });
          await closeIfOpen(prompt.paneId, outcomes);
          continue;
        }

        const fingerprint = fingerprintOf(prompt.dialog.question, prompt.dialog.options);
        if (open.get(prompt.paneId) === fingerprint) continue; // same episode already escalated
        await closeIfOpen(prompt.paneId, outcomes); // a DIFFERENT episode was open on this pane
        try {
          await hook.onUnknownDialog({
            paneId: prompt.paneId, label: prompt.label, sessionId: prompt.sessionId, cwd: prompt.cwd,
            herdrStatus: prompt.herdrStatus, question: prompt.dialog.question, options: prompt.dialog.options, fingerprint,
          });
          open.set(prompt.paneId, fingerprint);
          outcomes.push({ paneId: prompt.paneId, outcome: "escalated", fingerprint });
        } catch (error) {
          outcomes.push({ paneId: prompt.paneId, outcome: "hook-failed", phase: "escalate", detail: message(error) });
        }
      }

      // A pane with an open episode that vanished from `prompts` cleared —
      // either it stopped blocking, or its screen is `unreadable` this poll
      // (uncertain, so left open rather than resolved on a guess).
      const unreadableIds = new Set(unreadable.map((u) => u.paneId));
      for (const paneId of [...open.keys()]) {
        if (!seenPanes.has(paneId) && !unreadableIds.has(paneId)) await closeIfOpen(paneId, outcomes);
      }
      for (const u of unreadable) outcomes.push({ paneId: u.paneId, outcome: "unreadable", reason: u.reason });

      return outcomes;
    },
  };
}
