import { readClaudeTranscriptTail, type ClaudeTranscriptTail } from "./native-transcript.js";
import {
  ResidentMessageRefusal,
  type ResidentAgentMessenger,
  type ResidentAgentTarget,
  type ResidentMessageOptions,
  type ResidentMessageResult,
} from "./resident-agent.js";

/**
 * What a notification channel's acknowledgement actually proves.
 *
 * A channel that hands a frame to a live stream knows the stream took it. It
 * does not know that the far side's bridge kept it, that the resident's session
 * ever read it, or that any model was scheduled to look. An idle Claude session
 * drains its bridge only when it chooses to call the tool, which an idle
 * session never does — so a stream-level acknowledgement can be true at the
 * same moment the message is going nowhere.
 *
 * Drovr therefore refuses to translate `stream` into "delivered". Only
 * `session` — the channel proving the resident's own session recorded it — is
 * delivery, and every channel that cannot prove that much says so here.
 */
export type ChannelProof = "stream" | "session";

export interface ChannelAck {
  /** The channel's own verdict on its send; false goes straight to the wakeup path. */
  delivered: boolean;
  /** What that verdict proves. Absent is read as `stream`: the weaker claim, never assumed away. */
  proves?: ChannelProof;
  /** Carried through to the result untouched, for the caller's own logging. */
  detail?: unknown;
}

export type ResidentDelivery =
  /** The channel proved the session itself has the message; nothing was woken. */
  | { status: "channel-delivered"; ack: ChannelAck }
  /** A stream-level ack that the resident's own transcript then confirmed. */
  | { status: "channel-observed"; ack: ChannelAck }
  /** Unobserved on the channel, so the resident was woken through the proven transport. */
  | { status: "woken"; ack: ChannelAck | undefined; result: ResidentMessageResult }
  /** Neither path delivered; `reason` is the wakeup transport's own refusal. */
  | { status: "undelivered"; ack: ChannelAck | undefined; reason: ResidentMessageRefusal };

export interface ResidentDeliveryDeps {
  /** The proven same-session transport used to wake an unobserved resident. */
  messenger: ResidentAgentMessenger;
  /** Reads the resident's own transcript; defaults to Claude's on-disk one. */
  readTail?: (target: ResidentAgentTarget, offset: number) => Promise<ClaudeTranscriptTail>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ResidentDeliveryOptions extends ResidentMessageOptions {
  /**
   * How long a stream-level acknowledgement is given to show up in the
   * resident's transcript before the resident is woken instead. This is the
   * whole cost of a message an idle session was never going to read.
   */
  observationTimeoutMs?: number;
  pollMs?: number;
}

const DEFAULT_OBSERVATION_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 250;

/**
 * Deliver one message to a resident and be able to say which path delivered it.
 *
 * The channel is tried first because it is cheap and does not interrupt a
 * session that is already listening. What it returns is treated as evidence,
 * not as an outcome: unless the channel proves the session recorded the
 * message, Drovr watches the resident's own transcript for it, and wakes the
 * resident through the proven attach transport when it never appears.
 *
 * The bias is deliberate: an unobserved message is re-delivered by waking,
 * which can duplicate a message that was in fact received but not seen in time.
 * A duplicate is recoverable by a human reading it twice; a silently dropped
 * message to an idle coordinator is not recoverable at all.
 */
export async function deliverToResident(
  deps: ResidentDeliveryDeps,
  target: ResidentAgentTarget,
  text: string,
  send?: () => Promise<ChannelAck>,
  options: ResidentDeliveryOptions = {},
): Promise<ResidentDelivery> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const readTail = deps.readTail
    ?? ((resident: ResidentAgentTarget, offset: number) =>
      readClaudeTranscriptTail({ sessionId: resident.sessionId, cwd: resident.cwd }, offset));
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const observationTimeoutMs = options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS;

  // Read the transcript's end BEFORE sending, so nothing already written can be
  // mistaken for this message arriving.
  let offset: number | undefined;
  if (send) {
    try {
      offset = (await readTail(target, 0)).offset;
    } catch {
      // An unreadable transcript cannot witness anything; the channel's own
      // claim then decides, and a stream-level one goes to the wakeup path.
      offset = undefined;
    }
  }

  const ack = send ? await send() : undefined;
  if (ack?.delivered && ack.proves === "session") return { status: "channel-delivered", ack };

  if (ack?.delivered && offset !== undefined) {
    const observeBy = now() + observationTimeoutMs;
    for (;;) {
      let tail: ClaudeTranscriptTail;
      try {
        tail = await readTail(target, offset);
      } catch {
        break;
      }
      offset = tail.offset;
      // Shape-agnostic on purpose: a channel notification is not a user turn,
      // and its record shape belongs to the provider, not to Drovr.
      if (tail.text.includes(text)) return { status: "channel-observed", ack };
      if (now() >= observeBy) break;
      await sleep(pollMs);
    }
  }

  try {
    const result = await deps.messenger.message(target, text, options);
    return { status: "woken", ack, result };
  } catch (error) {
    if (error instanceof ResidentMessageRefusal) return { status: "undelivered", ack, reason: error };
    throw error;
  }
}
