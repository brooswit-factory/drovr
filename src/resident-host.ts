import { randomUUID } from "node:crypto";
import type { results } from "@brooswit/herdr-sdk";
import { buildProviderLaunchArgs, type ManagedAgentProvider, type ProviderLaunchInputs } from "./agent-runtime.js";
import { startManagedAgent, type AgentStartOptions } from "./agent-start.js";
import { classifyBlockingText, stripTerminalEscapes } from "./blocking-conditions.js";
import type { DrovrClient } from "./drovr-client.js";

/**
 * Hosting a resident: a long-lived interactive provider session in its own
 * herdr workspace pane, reachable by channel frames and by `--resume` later.
 *
 * Why a pane and not `claude --bg`: measured on claude 2.1.276, a background
 * session never shows the "Loading development channels" confirmation and
 * never delivers a channel frame as a turn, while the same session resumed in
 * a terminal pane, the confirmation answered, receives yappr and rocketr
 * frames as live turns (rocketr agent, session 517fd13a, 2026-09-18).
 *
 * Why every pane carries its label as its herdr agent name: herdr refuses a
 * second agent under a name already in use. On 2026-09-18 bakr started every
 * pane as `claude`, so once one pane held the name every later start failed
 * after its old session had already been stopped (seven agents down). A host
 * therefore checks the name is free before it creates anything.
 */

type AgentInfo = results.AgentInfo;

type HostClient = {
  agent: Pick<DrovrClient["agent"], "list" | "get" | "read" | "sendKeys" | "start" | "prompt">;
  pane: Pick<DrovrClient["pane"], "processInfo" | "read">;
  workspace: Pick<DrovrClient["workspace"], "create" | "close" | "list">;
};

/** Every workspace Drovr hosts carries this label prefix, so a listing can tell Drovr's panes from anyone else's. */
export const RESIDENT_WORKSPACE_PREFIX = "drovr ";

const residentWorkspaceLabel = (label: string): string => `${RESIDENT_WORKSPACE_PREFIX}${label}`;

/**
 * A label becomes the herdr agent name, so it follows herdr's rule, measured
 * 2026-09-18: lowercase letters, digits, `-` or `_`, 1 to 32 characters. A
 * name outside it is refused before a pane exists.
 */
const LABEL = /^[a-z0-9_-]{1,32}$/;

export interface HostResidentRequest {
  provider: ManagedAgentProvider;
  cwd: string;
  /** Unique on this host: the resident's herdr agent name. */
  label: string;
  /** Provider-neutral MCP and channel configuration; Drovr spells the flags. */
  inputs?: ProviderLaunchInputs;
  /** Native session id to resume. Omitted, Drovr names a fresh session itself. */
  resume?: string;
  /**
   * First user turn, submitted once the input box is ready. Not passed as an
   * argv prompt: measured 2026-09-18, a positional prompt given alongside the
   * trust and development-channels confirmations never became a turn.
   */
  prompt?: string;
  model?: string;
  env?: Record<string, string>;
}

export type HostResidentRefusalReason =
  /** Only Claude is hosted so far; other providers keep their managed lifecycles. */
  | "unsupported-provider"
  | "invalid-label"
  /** Another pane already holds this herdr agent name; nothing was created. */
  | "label-taken"
  | "workspace-failed"
  | "start-failed"
  /** A startup prompt Drovr does not answer; the workspace was closed. */
  | "blocked-prompt"
  /** `resume` named a session with no transcript here; the workspace was closed. */
  | "no-such-session"
  /** `resume` named a session whose conversation belongs to another directory. */
  | "wrong-directory"
  | "not-ready";

export type HostResidentResult =
  /** `promptError` is set when the resident is up but herdr refused its first turn. */
  | { ok: true; paneId: string; workspaceId: string; sessionId: string; promptError?: string }
  | { ok: false; reason: HostResidentRefusalReason; detail: string; paneId?: string; excerpt?: string };

export interface ResidentHostOptions {
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Passed to herdr's agent.start; herdr requires 3000 < value <= 300000. */
  startTimeoutMs?: number;
  /** Bounds the wait for a new pane's shell; defaults to 10s. */
  startOptions?: AgentStartOptions;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  mintSessionId?: () => string;
}

/** One option of a provider's startup menu, as its screen draws it. */
interface MenuOption { text: string; selected: boolean }

const CURSOR = /^\s*❯\s*/;

/**
 * The menu around the cursor: the run of non-blank lines holding the `❯`
 * line, each one option. Measured on claude 2.1.x, the trust menu is drawn
 * unnumbered ("❯ No, exit" above "Yes, I trust this folder"); other menus
 * number their options, so an "N. " prefix is dropped when present.
 */
function menuOptions(screen: string): MenuOption[] {
  const lines = screen.split(/\r?\n/);
  // The menu's cursor is the one nearest above its "Enter to confirm" footer.
  // Measured 2026-09-18: a live pane shows other `❯` lines too, earlier
  // prompts in the transcript above the menu and the input box below it.
  const footer = lines.findIndex((line) => /Enter to (confirm|continue)/.test(line));
  let cursor = -1;
  if (footer >= 0) {
    for (let i = footer - 1; i >= 0; i--) if (CURSOR.test(lines[i]!)) { cursor = i; break; }
  } else {
    cursor = lines.findIndex((line) => CURSOR.test(line));
  }
  if (cursor < 0) return [];
  let first = cursor, last = cursor;
  while (first > 0 && lines[first - 1]!.trim() !== "") first--;
  while (last < lines.length - 1 && lines[last + 1]!.trim() !== "") last++;
  return lines.slice(first, last + 1).map((line) => ({
    text: line.replace(CURSOR, "").trim().replace(/^\d+\.\s+/, ""),
    selected: CURSOR.test(line),
  }));
}

/**
 * The keys that move a menu's cursor onto the option matching `wanted` and
 * confirm it. Reads the cursor from the screen rather than assuming an order,
 * so a provider reordering its options cannot turn "trust" into "exit".
 */
export function keysToChoose(screen: string, wanted: RegExp): string[] | undefined {
  const options = menuOptions(screen);
  const target = options.findIndex((option) => wanted.test(option.text));
  const cursor = options.findIndex((option) => option.selected);
  if (target < 0 || cursor < 0) return undefined;
  const step = target > cursor ? "down" : "up";
  return [...Array.from({ length: Math.abs(target - cursor) }, () => step), "enter"];
}

type SetupRow = { kind: "box"; ticked: boolean } | { kind: "continue" } | { kind: "other" };

/**
 * The next keys on the auto-mode setup screen: move to the first unticked
 * "Also scan …" box and toggle it with Space, or, once every box reads
 * ticked, move to Continue and press Enter. Space as the toggle is not yet
 * observed live; if it does not tick a box the screen never shows every box
 * ticked, Continue is never pressed, and the launch ends `not-ready` with the
 * excerpt. Undefined when the screen lacks a visible cursor or Continue.
 */
function keysForOnboardingSetup(screen: string): string[] | undefined {
  const lines = screen.split(/\r?\n/);
  const footer = lines.findIndex((line) => /Enter to continue/.test(line));
  const title = lines.findIndex((line) => /Teach auto mode about your environment\?/.test(line));
  if (footer < 0 || title < 0 || title > footer) return undefined;
  const rows: (SetupRow & { selected: boolean })[] = [];
  for (const line of lines.slice(title + 1, footer)) {
    const selected = CURSOR.test(line);
    const text = line.replace(CURSOR, "").trim();
    const box = /^Also scan .+\[(.)\]$/.exec(text);
    if (box) rows.push({ kind: "box", ticked: box[1] !== " ", selected });
    else if (text === "Continue") rows.push({ kind: "continue", selected });
    else if (/◀.*▶/.test(text)) rows.push({ kind: "other", selected });
  }
  const cursor = rows.findIndex((row) => row.selected);
  const target = rows.findIndex((row) => row.kind === "box" && !row.ticked);
  const goal = target >= 0 ? target : rows.findIndex((row) => row.kind === "continue");
  if (cursor < 0 || goal < 0) return undefined;
  const step = goal > cursor ? "down" : "up";
  return [...Array.from({ length: Math.abs(goal - cursor) }, () => step), target >= 0 ? "space" : "enter"];
}

export type StartupPrompt =
  | { kind: "trust"; keys: string[] }
  | { kind: "development-channels"; keys: string[] }
  | { kind: "auto-mode-onboarding"; keys: string[] }
  | { kind: "mcp-approval"; excerpt: string }
  | { kind: "unknown-blocking"; excerpt: string };

const excerptOf = (screen: string): string => screen.trim().split("\n").slice(-14).join("\n");

/**
 * Which startup prompt a Claude pane shows, and the keys that answer it. Only
 * prompts a hosted resident must accept are answered: folder trust (the
 * caller chose this directory) and the development-channels warning (the
 * caller asked for those channels). An MCP approval prompt is reported, not
 * answered: approval travels on the launch (`mcpServersApproved`).
 */
export function classifyStartupPrompt(raw: string): StartupPrompt | undefined {
  const screen = stripTerminalEscapes(raw);
  if (/Is this a project you created or one you trust/.test(screen)) {
    const keys = keysToChoose(screen, /^Yes, I trust this folder/);
    return keys ? { kind: "trust", keys } : { kind: "unknown-blocking", excerpt: excerptOf(screen) };
  }
  if (/WARNING: Loading development channels/.test(screen)) {
    const keys = keysToChoose(screen, /^I am using this for local development/);
    return keys ? { kind: "development-channels", keys } : { kind: "unknown-blocking", excerpt: excerptOf(screen) };
  }
  if (/Teach auto mode about your environment\?/.test(screen) && /Enter to continue · Esc to cancel/.test(screen) && !/Enter to confirm/.test(screen)) {
    // The setup's second screen (measured on nexus-admin's pane wF:p1,
    // 2026-09-18). Brooswit's choice: both "Also scan …" boxes ticked, usage
    // left as shown, then Continue. One step per read, so every box is seen
    // ticked on screen before Enter is ever pressed.
    const keys = keysForOnboardingSetup(screen);
    return keys ? { kind: "auto-mode-onboarding", keys } : { kind: "unknown-blocking", excerpt: excerptOf(screen) };
  }
  if (/Looks good — save it/.test(screen) && /Discard and exit/.test(screen) && /Enter to confirm/.test(screen)) {
    // The setup's review of the environment it generated (measured on
    // yappr-3's pane wQ:p1, 2026-09-18). Decision relayed by the manager: save,
    // so each agent's view adds to the account-wide auto-mode environment.
    const keys = keysToChoose(screen, /^Looks good — save it$/);
    return keys ? { kind: "auto-mode-onboarding", keys } : { kind: "unknown-blocking", excerpt: excerptOf(screen) };
  }
  if (/You already have auto-mode entries/.test(screen) && /Enter to continue/.test(screen)) {
    // Shown after "Yes" once the account has auto-mode entries (measured on
    // yappr-3's pane wQ:p1, 2026-09-18). "Add to them" keeps Brooswit's
    // setup; "Start fresh" would replace it and is never chosen.
    const keys = keysToChoose(screen, /^Add to them\b/);
    return keys ? { kind: "auto-mode-onboarding", keys } : { kind: "unknown-blocking", excerpt: excerptOf(screen) };
  }
  if (/Teach auto mode about your environment\?/.test(screen)) {
    // A one-time offer, measured on lead-factory-dashboard's pane 2026-09-18.
    // Brooswit's choice is "Yes", which leads to the setup screen above.
    const keys = keysToChoose(screen, /^Yes$/);
    return keys ? { kind: "auto-mode-onboarding", keys } : { kind: "unknown-blocking", excerpt: excerptOf(screen) };
  }
  if (classifyBlockingText("claude", screen)?.kind === "mcp-approval-prompt") return { kind: "mcp-approval", excerpt: excerptOf(screen) };
  if (/Enter to confirm/.test(screen)) return { kind: "unknown-blocking", excerpt: excerptOf(screen) };
  return undefined;
}

/** The provider argv a hosted Claude resident starts with. */
export function buildResidentClaudeArgs(request: HostResidentRequest, sessionId: string): string[] {
  return [
    ...(request.resume === undefined ? ["--session-id", sessionId] : ["--resume", request.resume]),
    ...(request.model ? ["--model", request.model] : []),
    "--permission-mode", "bypassPermissions",
    ...buildProviderLaunchArgs("claude", request.inputs ?? {}),
  ];
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Start a resident in a new herdr workspace rooted at `cwd`, answer the
 * startup prompts it cannot, and return its pane once its input box is ready.
 * A resident that cannot get there has its workspace closed, so no
 * half-started pane is left holding an MCP identity or its agent name.
 */
export async function hostResident(
  client: HostClient,
  request: HostResidentRequest,
  options: ResidentHostOptions = {},
): Promise<HostResidentResult> {
  if (request.provider !== "claude") {
    return { ok: false, reason: "unsupported-provider", detail: `hosting ${request.provider} residents is not supported yet` };
  }
  if (!LABEL.test(request.label)) {
    return { ok: false, reason: "invalid-label", detail: `label ${JSON.stringify(request.label)} must be 1 to 32 lowercase letters, digits, '-' or '_' (herdr's agent-name rule)` };
  }
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  const holder = (await client.agent.list()).agents.find((agent) => agent.name === request.label);
  if (holder) {
    return { ok: false, reason: "label-taken", paneId: holder.pane_id, detail: `pane ${holder.pane_id} already holds the herdr agent name ${request.label}` };
  }

  let created: results.Result_workspace_created;
  try {
    created = await client.workspace.create({
      cwd: request.cwd,
      label: residentWorkspaceLabel(request.label),
      focus: false,
      ...(request.env ? { env: request.env } : {}),
    });
  } catch (error) {
    return { ok: false, reason: "workspace-failed", detail: `herdr could not create a workspace: ${message(error)}` };
  }
  const paneId = created.root_pane.pane_id;
  const workspaceId = created.workspace.workspace_id;
  const abandon = async (reason: HostResidentRefusalReason, detail: string, excerpt?: string): Promise<HostResidentResult> => {
    await client.workspace.close({ workspace_id: workspaceId }).catch(() => undefined);
    return { ok: false, reason, detail, paneId, ...(excerpt === undefined ? {} : { excerpt }) };
  };

  const minted = request.resume ?? (options.mintSessionId ?? randomUUID)();
  try {
    // A new workspace's shell can still be starting (herdr: "not an available
    // shell"); startManagedAgent retries only that refusal, within its bound.
    await startManagedAgent(client, {
      kind: "claude",
      name: request.label,
      pane_id: paneId,
      args: buildResidentClaudeArgs(request, minted),
      timeout_ms: options.startTimeoutMs ?? 60_000,
    }, { readinessTimeoutMs: 10_000, ...options.startOptions });
  } catch (error) {
    // A start that timed out waiting for readiness is often a startup prompt
    // on screen; the loop below reads it. Anything else is a real failure.
    if ((error as { code?: unknown }).code !== "agent_not_ready") {
      return abandon("start-failed", `claude did not start in pane ${paneId}: ${message(error)}`);
    }
  }

  const readyBy = now() + (options.readyTimeoutMs ?? 90_000);
  for (;;) {
    const agent: AgentInfo | undefined = await client.agent.get(paneId).then((got) => got.agent, () => undefined);
    // Once the provider exits (a resume of a session with no transcript, for
    // one) the pane holds no agent; its shell screen still says why.
    const screen = await client.agent.read({ target: paneId, source: "visible", strip_ansi: true })
      .catch(() => client.pane.read({ pane_id: paneId, source: "recent", strip_ansi: true }))
      .then((read) => read.read.text, () => "");
    const prompt = classifyStartupPrompt(screen);
    if (prompt === undefined && agent?.interactive_ready && agent.agent_status !== "blocked" && agent.agent_status !== "unknown") {
      const listed = agent.agent_session?.kind === "id" ? agent.agent_session.value : undefined;
      const hosted = { ok: true as const, paneId, workspaceId, sessionId: listed ?? minted };
      if (request.prompt === undefined) return hosted;
      // The resident is up either way; a refused first turn is reported, never a reason to close it.
      return client.agent.prompt({ target: paneId, text: request.prompt })
        .then(() => hosted, (error) => ({ ...hosted, promptError: message(error) }));
    }
    // Measured on claude 2.1.x: a resume of a session with no transcript (one
    // that never took a turn) prints this and exits to the shell.
    const missing = /No conversation found with session ID: (\S+)/.exec(screen);
    if (request.resume !== undefined && missing) {
      return abandon("no-such-session", `claude has no transcript for session ${missing[1]} in ${request.cwd}`, excerptOf(screen));
    }
    // This text is in Claude's binary but has never been observed on a screen:
    // claude 2.1.277 resumed from other directories without it. Named, not
    // left to the unknown-prompt path, in case another version shows it.
    if (request.resume !== undefined && /This conversation is from a different directory/.test(screen)) {
      return abandon("wrong-directory", `session ${request.resume} belongs to another directory than ${request.cwd}; resume from the transcript's last recorded cwd`, excerptOf(screen));
    }
    if (prompt?.kind === "mcp-approval") {
      return abandon("blocked-prompt", `claude in pane ${paneId} asks to approve an MCP server; pass it in inputs.mcpServersApproved`, prompt.excerpt);
    }
    if (prompt?.kind === "unknown-blocking") {
      return abandon("blocked-prompt", `claude in pane ${paneId} is blocked on a prompt Drovr does not answer`, prompt.excerpt);
    }
    if (prompt !== undefined) await client.agent.sendKeys({ target: paneId, keys: prompt.keys }).catch(() => undefined);
    if (now() >= readyBy) return abandon("not-ready", `claude in pane ${paneId} never reached its input box`, excerptOf(screen));
    await wait(pollIntervalMs);
  }
}

export interface ResidentListing {
  paneId: string;
  workspaceId: string;
  label: string;
  provider: string | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
  status: AgentInfo["agent_status"];
  /** The provider process's pid, for a host's own liveness check; undefined when herdr cannot say. */
  pid: number | undefined;
}

/** Every resident Drovr hosts: agent panes in a workspace carrying Drovr's label prefix. */
export async function listResidents(client: Pick<HostClient, "agent" | "workspace" | "pane">): Promise<ResidentListing[]> {
  const [{ agents }, { workspaces }] = await Promise.all([client.agent.list(), client.workspace.list()]);
  const hosted = new Map(workspaces
    .filter((workspace) => workspace.label.startsWith(RESIDENT_WORKSPACE_PREFIX))
    .map((workspace) => [workspace.workspace_id, workspace.label.slice(RESIDENT_WORKSPACE_PREFIX.length)]));
  const residents = agents.filter((agent) => hosted.has(agent.workspace_id));
  const pids = await Promise.all(residents.map((agent) => providerPid(client, agent.pane_id, agent.agent ?? undefined)));
  return residents.map((agent, index) => ({
    paneId: agent.pane_id,
    workspaceId: agent.workspace_id,
    label: agent.name ?? hosted.get(agent.workspace_id)!,
    provider: agent.agent ?? undefined,
    sessionId: agent.agent_session?.kind === "id" ? agent.agent_session.value : undefined,
    cwd: agent.cwd ?? undefined,
    status: agent.agent_status,
    pid: pids[index],
  }));
}

/**
 * The pane's foreground process named after its provider, as `pane.process_info`
 * reports it. Undefined when herdr cannot say; never the shell's pid instead.
 */
async function providerPid(client: Pick<HostClient, "pane">, paneId: string, provider: string | undefined): Promise<number | undefined> {
  if (provider === undefined) return undefined;
  const result = await client.pane.processInfo({ pane_id: paneId }).catch(() => undefined);
  const processes = result?.type === "pane_process_info" ? result.process_info.foreground_processes : undefined;
  const pid = processes?.find((process) => process.name === provider)?.pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export type StopResidentResult =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: "not-found" | "not-hosted" | "close-failed"; detail: string };

/**
 * Close a hosted resident's whole workspace: the provider process ends and
 * its transcript stays for a later `resume`. Refuses a pane Drovr did not
 * host, so a stale id can never close someone else's workspace.
 */
export async function stopResident(client: Pick<HostClient, "agent" | "workspace" | "pane">, paneId: string): Promise<StopResidentResult> {
  const resident = (await listResidents(client)).find((listing) => listing.paneId === paneId);
  if (!resident) {
    const exists = await client.agent.get(paneId).then(() => true, () => false);
    return exists
      ? { ok: false, reason: "not-hosted", detail: `pane ${paneId} is not in a workspace Drovr hosts` }
      : { ok: false, reason: "not-found", detail: `no agent pane ${paneId}` };
  }
  try {
    await client.workspace.close({ workspace_id: resident.workspaceId });
    return { ok: true, workspaceId: resident.workspaceId };
  } catch (error) {
    return { ok: false, reason: "close-failed", detail: message(error) };
  }
}
