import type { ResultOf } from "@brooswit/herdr-sdk";
import type { Correction, CorrectionContext } from "./corrections.js";
import type { DrovrClient } from "./drovr-client.js";

type Agent = ResultOf<"agent.get">["agent"];

function isActiveTrustDialog(text: string): boolean {
  // Anchor the whole visible screen, not a substring in a transcript. Keep
  // selection markers significant while allowing terminal line wrapping.
  const screen = text.trim().replace(/\s+/g, " ");
  return /^(?:[>\u203a\u276f] )?You are in \/[^\r\n]+? Do you trust the contents of this directory\? Working with untrusted contents comes with higher risk of prompt injection\. Trusting the directory allows project-local config, hooks, and exec policies to load\. (?:[>\u203a\u276f] 1\. Yes, continue 2\. No, quit|1\. Yes, continue [>\u203a\u276f] 2\. No, quit) Press enter to continue\.?$/.test(screen);
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
