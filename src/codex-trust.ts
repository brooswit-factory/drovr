import type { ResultOf } from "@brooswit/herdr-sdk";
import type { Correction, CorrectionContext } from "./corrections.js";
import type { DrovrClient } from "./drovr-client.js";

type Agent = ResultOf<"agent.get">["agent"];

/**
 * The directory heading's path, either shape: POSIX (e.g. "/home/x"), a
 * Windows drive path ("C:\x" or "C:/x"), or a UNC share ("\\host\x"). No
 * Windows ConPTY capture of this dialog exists yet to confirm which form
 * Codex actually prints there (FACTORY-561 -- flagged on the ticket for a
 * real zippy run); this widens the match defensively rather than assuming
 * the POSIX-only shape the original Linux capture required.
 */
const TRUST_PATH = /(?:\/|[A-Za-z]:[\\/]|\\\\)[^\r\n]+?/.source;

function isActiveTrustDialog(text: string): boolean {
  // Anchor the whole visible screen, not a substring in a transcript. Keep
  // selection markers significant while allowing terminal line wrapping.
  const screen = text.trim().replace(/\s+/g, " ");
  return new RegExp(
    `^(?:[>\u203a\u276f] )?You are in ${TRUST_PATH} Do you trust the contents of this directory\\? Working with untrusted contents comes with higher risk of prompt injection\\. Trusting the directory allows project-local config, hooks, and exec policies to load\\. (?:[>\u203a\u276f] 1\\. Yes, continue 2\\. No, quit|1\\. Yes, continue [>\u203a\u276f] 2\\. No, quit) Press enter to continue\\.?$`,
  ).test(screen);
}

/** Which of the dialog's two options currently carries the cursor marker (`>`, `\u203a`, or `\u276f`). */
const CODEX_TRUST_OPTION = /^\s*(?:([>\u203a\u276f])\s*)?([12])\.\s*(?:Yes, continue|No, quit)\s*$/;

/**
 * The keys that move the Codex directory-trust dialog's cursor onto
 * "Yes, continue" and confirm it, or `undefined` when the screen is not
 * (verbatim) that dialog. Read from the screen rather than assumed: the
 * cursor is observed live on either option (`isActiveTrustDialog` accepts
 * both), so the direction is derived, never hard-coded.
 */
export function keysForCodexTrust(raw: string): string[] | undefined {
  if (!isActiveTrustDialog(raw)) return undefined;
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  let cursor = -1;
  for (const line of lines) {
    const match = CODEX_TRUST_OPTION.exec(line);
    if (match?.[1]) { cursor = Number(match[2]) - 1; break; }
  }
  if (cursor < 0) return undefined; // exact-text match already required a cursor; unreachable in practice
  const target = 0; // "Yes, continue"
  return cursor === target ? ["enter"] : [target > cursor ? "down" : "up", "enter"];
}

async function correctAgent(agent: Agent, client: DrovrClient): Promise<Agent> {
  if (agent?.agent !== "codex" ||
      (agent.agent_status !== "idle" && agent.agent_status !== "done") || !agent.pane_id) return agent;
  try {
    const { read } = await client.pane.read({
      pane_id: agent.pane_id,
      source: "visible",
      format: "text",
      strip_ansi: true,
    });
    if (read.pane_id !== agent.pane_id || read.source !== "visible" ||
        read.format !== "text" || read.truncated || !isActiveTrustDialog(read.text)) return agent;
    return { ...agent, agent_status: "blocked", interactive_ready: false };
  } catch {
    // Missing evidence is unknown: retain the original report, not a block.
    return agent;
  }
}

export const correctCodexTrustList: Correction<"agent.list"> = async (result, ctx) => {
  if (!Array.isArray(result.agents)) return result;
  const agents = await Promise.all(result.agents.map((agent) => correctAgent(agent, ctx.client)));
  return agents.some((agent, index) => agent !== result.agents[index]) ? { ...result, agents } : result;
};

export async function correctCodexTrustAgent<M extends "agent.get" | "agent.start" | "agent.prompt" | "agent.wait">(
  result: ResultOf<M>, ctx: CorrectionContext<M>,
): Promise<ResultOf<M>> {
    const agent = await correctAgent(result.agent, ctx.client);
    return agent === result.agent ? result : { ...result, agent };
}
