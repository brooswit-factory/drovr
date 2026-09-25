import { stripTerminalEscapes } from "./blocking-conditions.js";
import type { DrovrClient } from "./drovr-client.js";
import { readPaneWithDeadline, type PaneReadDeadlineOptions, type UnreadablePane } from "./pane-scan.js";
import { classifyPermissionPrompt } from "./permission-approval.js";
import { classifyStartupPrompt } from "./resident-host.js";

export type { UnreadablePane } from "./pane-scan.js";

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

export interface ScanBlockingPromptsOptions extends PaneReadDeadlineOptions {}

export interface ScanBlockingPromptsResult {
  prompts: BlockingPrompt[];
  unreadable: UnreadablePane[];
}

/**
 * Every Claude pane waiting on a dialog. Every Claude pane's screen is read,
 * whatever herdr says its status is, bounded by `readTimeoutMs` (default
 * 1500) per pane so one hung `agent.read` can't hold up the whole scan —
 * reads run in parallel, so the scan takes roughly the slowest read, capped
 * by the deadline. A pane whose screen cannot be read — it rejects, or it
 * never resolves within the deadline — is reported in `unreadable`, never
 * silently treated as "not blocked".
 */
export async function scanBlockingPrompts(client: ScanClient, options: ScanBlockingPromptsOptions = {}): Promise<ScanBlockingPromptsResult> {
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
    const blocking = classifyBlockingScreen(read.screen);
    return blocking === undefined ? {} : { prompt: { ...base, ...blocking } };
  }));
  return {
    prompts: found.flatMap((r) => (r.prompt ? [r.prompt] : [])),
    unreadable: found.flatMap((r) => (r.unreadable ? [r.unreadable] : [])),
  };
}

/**
 * Every Claude pane waiting on a dialog. A thin wrapper over
 * `scanBlockingPrompts` that drops its `unreadable` list — a pane whose
 * screen could not be read is silently absent from the result, exactly as
 * before. Callers that need to tell "not blocked" apart from "could not
 * check" should call `scanBlockingPrompts` directly.
 */
export async function listBlockingPrompts(client: ScanClient): Promise<BlockingPrompt[]> {
  return (await scanBlockingPrompts(client)).prompts;
}
