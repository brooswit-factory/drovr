import { stripTerminalEscapes } from "./blocking-conditions.js";
import type { DrovrClient } from "./drovr-client.js";
import { classifyPermissionPrompt } from "./permission-approval.js";
import { classifyStartupPrompt } from "./resident-host.js";

/**
 * Every dialog a Claude pane is waiting on, so nothing hangs unseen.
 *
 * On 2026-09-18 two agents sat on a menu no one had met before ("Teach auto
 * mode about your environment?") until Brooswit noticed and answered by hand,
 * while herdr reported both panes idle or done. A host polls this, answers
 * what Drovr knows how to answer, and alerts a person on `unknown`.
 */

type ScanClient = { agent: Pick<DrovrClient["agent"], "list" | "read"> };

/**
 * - `startup`: a prompt `hostResident` answers (trust, development channels,
 *   auto-mode setup), or reports by name (MCP approval).
 * - `permission`: a tool-permission prompt `approvePermission` answers for an operator.
 * - `unknown`: a waiting dialog Drovr recognises by its footer alone; a person must look.
 */
export type BlockingPromptKind = "startup" | "permission" | "unknown";

export interface BlockingPrompt {
  paneId: string;
  label: string | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
  /** herdr's own status, reported alongside because herdr often calls these panes idle. */
  herdrStatus: string;
  kind: BlockingPromptKind;
  /** For `startup` and `permission`: which prompt, e.g. "trust" or the tool name. */
  name: string | undefined;
  /** The last lines of the screen, escapes stripped. */
  excerpt: string;
}

/**
 * The footers Claude draws under a dialog that waits for an answer. A menu is
 * only counted when its footer is on screen, so a transcript that merely
 * quotes a prompt's text is never reported.
 */
const WAITING_FOOTER = /(Enter to confirm|Enter to continue|Enter to select|Esc to cancel)/;

const excerptOf = (screen: string): string => screen.trim().split("\n").slice(-16).join("\n");

/** What one screen is waiting on, or undefined when it waits on nothing. */
export function classifyBlockingScreen(raw: string): Pick<BlockingPrompt, "kind" | "name" | "excerpt"> | undefined {
  const screen = stripTerminalEscapes(raw);
  if (!WAITING_FOOTER.test(screen)) return undefined;
  const permission = classifyPermissionPrompt(screen);
  if (permission) return { kind: "permission", name: permission.tool, excerpt: excerptOf(screen) };
  const startup = classifyStartupPrompt(screen);
  if (startup && startup.kind !== "unknown-blocking") return { kind: "startup", name: startup.kind, excerpt: excerptOf(screen) };
  return { kind: "unknown", name: undefined, excerpt: excerptOf(screen) };
}

/**
 * Every Claude pane waiting on a dialog. Every Claude pane's screen is read,
 * whatever herdr says its status is. A pane whose screen cannot be read is
 * skipped, never reported as blocked.
 */
export async function listBlockingPrompts(client: ScanClient): Promise<BlockingPrompt[]> {
  const { agents } = await client.agent.list();
  const found = await Promise.all(agents.filter((agent) => agent.agent === "claude").map(async (agent) => {
    const screen = await client.agent.read({ target: agent.pane_id, source: "visible", strip_ansi: true })
      .then((read) => read.read.text, () => undefined);
    const blocking = screen === undefined ? undefined : classifyBlockingScreen(screen);
    return blocking === undefined ? [] : [{
      paneId: agent.pane_id,
      label: agent.name ?? undefined,
      sessionId: agent.agent_session?.kind === "id" ? agent.agent_session.value : undefined,
      cwd: agent.cwd ?? undefined,
      herdrStatus: agent.agent_status,
      ...blocking,
    }];
  }));
  return found.flat();
}
