import { HerdrError, type ParamsOf, type ResultOf } from "@brooswit/herdr-sdk";
import type { DrovrClient } from "./drovr-client.js";
import { checkCanonicalMode, type CanonicalModeState } from "./terminal-readiness.js";

export interface AgentStartOptions {
  /** Bounds retries after confirmed shell-busy rejections, not an in-flight launch. */
  readinessTimeoutMs?: number;
  retryIntervalMs?: number;
  /** Monotonic clock and wait injection for deterministic tests. */
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** Test seam for the bounded, read-only timeout diagnostic. */
  diagnosticWait?: (ms: number) => Promise<void>;
  /**
   * FACTORY-1037: bounded ceiling for waiting on the pane's shell to actually
   * leave kernel canonical TTY mode before agent.start is ever called -- see
   * awaitNonCanonical's own doc comment for the failure this guards against.
   * Separate from readinessTimeoutMs, which bounds retries AFTER an explicit
   * agent_pane_busy refusal: this runs BEFORE the first attempt, because the
   * failure here is silent truncation at injection time, not a rejected
   * call. Default 5000ms is a conservative guess, not a measured herdr SLA
   * (herdr publishes none for how long a pane may stay canonical).
   */
  canonicalModeTimeoutMs?: number;
  /** Test seam; real implementation in terminal-readiness.ts. */
  checkCanonicalMode?: (shellPid: number) => Promise<CanonicalModeState>;
}

export class AgentTerminalNotReadyError extends Error {
  readonly code = "agent_terminal_canonical_mode_timeout";

  constructor(readonly paneId: string, readonly elapsedMs: number) {
    super(`Pane ${paneId}'s shell is still in kernel canonical TTY mode after ${elapsedMs}ms -- refusing to inject, since a line over the kernel's canonical-mode limit would be silently truncated with no error`);
    this.name = "AgentTerminalNotReadyError";
  }
}

export interface ShellReadinessDiagnostics {
  attempts: number;
  elapsedMs: number;
  processInfo: "available" | "unavailable";
  shellPid?: number;
  foregroundProcessGroupId?: number;
  foregroundProcessCount?: number;
  otherForegroundProcessCount?: number;
}

export class AgentShellReadinessError extends Error {
  readonly code = "agent_shell_readiness_timeout";

  constructor(readonly diagnostics: ShellReadinessDiagnostics) {
    super(`Agent shell readiness expired: ${JSON.stringify(diagnostics)}`);
    this.name = "AgentShellReadinessError";
  }
}

type StartClient = {
  agent: Pick<DrovrClient["agent"], "start">;
  pane: Pick<DrovrClient["pane"], "processInfo">;
};

const positive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
  return value;
};
const pid = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/**
 * A hung or failed pane.processInfo read must never block real progress --
 * bounded to at most `boundMs` (default 250ms) via the same diagnosticWait
 * test seam every caller already uses, so a fake clock stays finite too.
 */
async function boundedProcessInfo(client: StartClient, paneId: string, diagnosticWait?: (ms: number) => Promise<void>, boundMs = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => client.pane.processInfo({ pane_id: paneId })).catch(() => undefined),
      diagnosticWait
        ? diagnosticWait(boundMs).then(() => undefined)
        : new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), boundMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function diagnose(client: StartClient, paneId: string, diagnosticWait?: (ms: number) => Promise<void>): Promise<Omit<ShellReadinessDiagnostics, "attempts" | "elapsedMs">> {
  try {
    const result = await boundedProcessInfo(client, paneId, diagnosticWait);
    const info = result?.type === "pane_process_info" ? result.process_info : undefined;
    if (!info) return { processInfo: "unavailable" };
    const shellPid = pid(info.shell_pid);
    const foregroundProcessGroupId = pid(info.foreground_process_group_id);
    const processes = info.foreground_processes;
    // Never include argv, command lines, cwd, process names, or server errors.
    return {
      processInfo: "available",
      ...(shellPid === undefined ? {} : { shellPid }),
      ...(foregroundProcessGroupId === undefined ? {} : { foregroundProcessGroupId }),
      ...(Array.isArray(processes) ? {
        foregroundProcessCount: processes.length,
        ...(shellPid === undefined ? {} : {
          otherForegroundProcessCount: processes.filter((process) => process.pid !== shellPid).length,
        }),
      } : {}),
    };
  } catch {
    return { processInfo: "unavailable" };
  }
}

/**
 * FACTORY-1037: herdr's own pre-launch busy check is foreground-process-based
 * and cannot see a pane whose shell has no foreground child (so herdr
 * considers it available) but has not yet called tcsetattr to leave kernel
 * canonical TTY mode -- injecting into that window silently truncates any
 * line over the kernel's canonical-mode limit, with no error and no
 * terminating newline delivered, so the command never submits (reproduced
 * both in isolation with a bare pty pair, and live against a real herdr with
 * a deliberately slow shell startup -- see that ticket's evidence).
 *
 * Polls checkCanonicalMode (a ground-truth /proc + stty read, not herdr's
 * self-report) until it reports anything other than "canonical", or the
 * bound passes. "unavailable" (no /proc entry, no stty, a non-Linux host,
 * herdr not yet reporting a shell_pid) is NOT treated as "ready" OR as
 * "refuse" -- it means this mechanism cannot verify anything here, so it
 * degrades to the pre-existing, unprotected behavior (proceed immediately)
 * rather than ever blocking a platform this check doesn't support. Only a
 * POSITIVE "canonical" reading holds the gate.
 *
 * Past the bound while still confirmed "canonical", this throws rather than
 * proceeding: by then we have DIRECT, repeated confirmation injection is
 * unsafe, so proceeding anyway would defeat the entire point of the gate.
 */
async function awaitNonCanonical(
  client: StartClient,
  paneId: string,
  options: { timeoutMs: number; intervalMs: number; now: () => number; wait: (ms: number) => Promise<void>; diagnosticWait?: (ms: number) => Promise<void>; check: (shellPid: number) => Promise<CanonicalModeState> },
): Promise<void> {
  const { timeoutMs, intervalMs, now, wait, diagnosticWait, check } = options;
  const started = now();
  const deadline = started + timeoutMs;
  for (;;) {
    // Bounded the same way diagnose()'s own read is: a hung or failed
    // processInfo call must never defeat this gate's own bound.
    const info = await boundedProcessInfo(client, paneId, diagnosticWait);
    const shellPid = pid(info?.type === "pane_process_info" ? info.process_info.shell_pid : undefined);
    if (shellPid === undefined) return; // cannot resolve a shell yet to check -- nothing more this gate can verify
    const state = await check(shellPid);
    if (state !== "canonical") return; // "raw" (safe) or "unavailable" (cannot verify) -- proceed either way
    const remaining = deadline - now();
    if (remaining <= 0) throw new AgentTerminalNotReadyError(paneId, Math.max(0, Math.round(now() - started)));
    await wait(Math.min(intervalMs, remaining));
  }
}

/**
 * Herdr alone decides whether a pane is an available supported shell. Retry
 * only its explicit pre-launch busy refusal; uncertain failures must never
 * cause a second launch. The native agent.start timeout remains unchanged.
 * On exhaustion, a best-effort diagnostic read adds at most 250ms.
 * The caller retains ownership of pane cleanup and provider fallback.
 *
 * Before any of that: awaitNonCanonical (FACTORY-1037) gates the FIRST call
 * itself, since the failure it guards against is a silent kernel-level
 * truncation at injection time, not something a post-hoc retry can undo.
 */
export async function startManagedAgent(
  client: StartClient,
  params: ParamsOf<"agent.start">,
  options: AgentStartOptions = {},
): Promise<ResultOf<"agent.start">> {
  const timeout = positive(options.readinessTimeoutMs ?? 5_000, "readinessTimeoutMs");
  const interval = positive(options.retryIntervalMs ?? 200, "retryIntervalMs");
  const canonicalModeTimeout = positive(options.canonicalModeTimeoutMs ?? 5_000, "canonicalModeTimeoutMs");
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await awaitNonCanonical(client, params.pane_id, {
    timeoutMs: canonicalModeTimeout,
    intervalMs: interval,
    now,
    wait,
    ...(options.diagnosticWait ? { diagnosticWait: options.diagnosticWait } : {}),
    check: options.checkCanonicalMode ?? checkCanonicalMode,
  });
  const started = now();
  const deadline = started + timeout;
  let attempts = 0;
  while (attempts === 0 || now() < deadline) {
    attempts++;
    try {
      return await client.agent.start(params);
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy") throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(interval, remaining));
  }
  const elapsedMs = Math.max(0, Math.round(now() - started));
  throw new AgentShellReadinessError({ attempts, elapsedMs, ...await diagnose(client, params.pane_id, options.diagnosticWait) });
}
