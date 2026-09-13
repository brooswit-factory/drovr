import { HerdrError, type ParamsOf, type ResultOf } from "@brooswit/herdr-sdk";
import type { DrovrClient } from "./drovr-client.js";

export interface AgentStartOptions {
  /** Bounds retries after confirmed shell-busy rejections, not an in-flight launch. */
  readinessTimeoutMs?: number;
  retryIntervalMs?: number;
  /** Monotonic clock and wait injection for deterministic tests. */
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** Test seam for the bounded, read-only timeout diagnostic. */
  diagnosticWait?: (ms: number) => Promise<void>;
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

async function diagnose(client: StartClient, paneId: string, diagnosticWait?: (ms: number) => Promise<void>): Promise<Omit<ShellReadinessDiagnostics, "attempts" | "elapsedMs">> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => client.pane.processInfo({ pane_id: paneId })).catch(() => undefined),
      diagnosticWait
        ? diagnosticWait(250).then(() => undefined)
        : new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 250); }),
    ]);
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
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Herdr alone decides whether a pane is an available supported shell. Retry
 * only its explicit pre-launch busy refusal; uncertain failures must never
 * cause a second launch. The native agent.start timeout remains unchanged.
 * On exhaustion, a best-effort diagnostic read adds at most 250ms.
 * The caller retains ownership of pane cleanup and provider fallback.
 */
export async function startManagedAgent(
  client: StartClient,
  params: ParamsOf<"agent.start">,
  options: AgentStartOptions = {},
): Promise<ResultOf<"agent.start">> {
  const timeout = positive(options.readinessTimeoutMs ?? 5_000, "readinessTimeoutMs");
  const interval = positive(options.retryIntervalMs ?? 200, "retryIntervalMs");
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
