import type { DrovrClient } from "./drovr-client.js";

/**
 * A pane a scan could not classify, because its screen could not be read at
 * all — distinct from a pane whose screen was read and simply isn't waiting
 * on anything. Without this, `agent.read` failing or hanging silently reads
 * as "not blocked" / "no pending prompt", which is worse than an error: it
 * looks like a clean result. See DROVR-33.
 */
export interface UnreadablePane {
  paneId: string;
  label: string | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
  /** herdr's own status, reported alongside because herdr often calls these panes idle. */
  herdrStatus: string;
  reason: "timeout" | "error";
  detail: string;
}

export interface PaneReadDeadlineOptions {
  /** Bounds one pane's `agent.read`, not the whole scan. Reads run in parallel. */
  readTimeoutMs?: number;
  /** Test seam: replaces the real per-read timer, so a hung read can be raced deterministically without real sleeping. */
  readWait?: (ms: number) => Promise<void>;
}

const DEFAULT_READ_TIMEOUT_MS = 1_500;

type ReadClient = { agent: Pick<DrovrClient["agent"], "read"> };

export type PaneReadOutcome =
  | { kind: "ok"; screen: string }
  | { kind: "timeout"; detail: string }
  | { kind: "error"; detail: string };

/**
 * One pane's screen, bounded by `readTimeoutMs`. herdr's own client timeout
 * is too coarse for a status poll with a budget of a couple of seconds (a
 * caller like bakr passes 15s) — this races a local deadline instead, so a
 * hung `agent.read` never holds a scan past `readTimeoutMs`. The losing
 * timer is always cleared, whichever side settles first.
 */
export async function readPaneWithDeadline(client: ReadClient, paneId: string, options: PaneReadDeadlineOptions = {}): Promise<PaneReadOutcome> {
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.agent.read({ target: paneId, source: "visible", strip_ansi: true })
        .then((read): PaneReadOutcome => ({ kind: "ok", screen: read.read.text }))
        .catch((error): PaneReadOutcome => ({ kind: "error", detail: error instanceof Error ? error.message : String(error) })),
      options.readWait
        ? options.readWait(readTimeoutMs).then((): PaneReadOutcome => ({ kind: "timeout", detail: `no read within ${readTimeoutMs}ms` }))
        : new Promise<PaneReadOutcome>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "timeout", detail: `no read within ${readTimeoutMs}ms` }), readTimeoutMs);
          }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
