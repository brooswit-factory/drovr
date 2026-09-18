# Resident agent messaging

A resident is a long-lived agent session that is already running, such as a
Bakr agent. `createResidentAgentMessenger()` is the provider-neutral way for a
host to send it one message and read its reply. The host passes identity only:

```ts
const messenger = createResidentAgentMessenger();
const result = await messenger.message(
  { provider: "claude", sessionId, cwd },
  "What is left to do?",
  { replyTimeoutMs: 300_000 },
);
// { status: "replied", reply } | { status: "reply-pending", reply }
```

The message always reaches the same running session or is refused with a
`ResidentMessageRefusal`. Nothing resumes, forks, or starts another session.

| Reason | Meaning |
| --- | --- |
| `unsupported-provider` | No proven same-session transport exists for this provider |
| `invalid-message` | Empty, over 16,000 characters, or contains controls other than newline/tab |
| `not-running` | No running background session has this `sessionId`. `cwd` only says where to look first: a resident that moved into a worktree is reached, and its transcript read, wherever it now is |
| `busy` | The session is mid-turn (a session busy only with background workers after its turn ended is sendable) |
| `blocked` | The session lists no status and its screen shows a startup prompt (such as MCP approval) that a typed Enter would answer |
| `delivery-unconfirmed` | Typed, but the session's transcript never recorded it |

`reply-pending` means delivery was proven but the turn had not ended before the
timeout; `reply` holds the assistant text so far.

## Claude transport

Measured on Claude Code 2.1.274. Claude has no machine API that delivers to a
running background session:

- `claude -p --resume <id>` exits 1 while the session runs: "Session … is
  running as a background session … Run `claude attach` to open it, or
  `claude stop` first to resume it here. Add --fork-session to branch off a
  copy instead."
- `--fork-session`, and `claude --bg --resume` on a running session, create a
  copy. That is a different session, so neither is used.

The only path into the same process is the documented interactive
`claude attach <shortId>`. `ClaudeResidentMessenger`:

1. Requires the exact `sessionId` in `claude agents --json` as a `background`
   entry, and uses that entry's `cwd`, which is where the session is now.
   Attaching an absent job wakes it, so absence is refused before any attach.
   `status: "idle"` is sendable. No status at all (measured on a
   never-prompted session) is sendable unless `claude logs` shows a blocking
   prompt. Any other status is read with the transcript
   (`claudeResidentActivity`): Claude lists a session `busy` for as long as a
   Monitor or background shell runs, even while it waits at its prompt. If the
   last main-thread conversation record is the `turn_duration` that closed a
   turn, the session is `background` and sendable; otherwise it is mid-turn
   and refused as `busy`. herdr's screen detection already calls such a pane
   `done`. The name avoids `working`, which herdr and bakr use for mid-turn.
   Measured 2026-09-18: lead-dynamic-atmosphere listed `busy` sixteen minutes
   after its last turn ended, with only its watcher running.
2. Records the transcript end, opens `claude attach` in a PTY, waits for output
   to settle, sends the message as a bracketed paste, then Enter.
3. Counts delivery only when a user record with exactly that text appears in
   `~/.claude/projects/<cwd>/<sessionId>.jsonl`, then detaches by stopping the
   attach client. The background session keeps running. A session that entered
   a worktree has its transcript moved to that worktree's project folder, so
   the file is found by `sessionId` in whichever project folder holds it.
4. Reads assistant text blocks after that record, skipping sidechains, until
   `system` / `turn_duration` marks the end of the turn.

Live check: a running background session (same pid before and after, no new
transcript file) replied `13` in about 5.5 s. A freshly created, never-prompted
session has no transcript file until its first turn; delivery is then proven
from the file that turn creates (live via Bakr on Claude Code 2.1.274, same pid
before and after).

Limits: this is terminal automation over an interactive command. The transcript
check makes delivery claims honest, but prompt layout, paste handling, and the
`turn_duration` marker are not documented contracts and may change. One
messenger serializes its own sends; separate processes, or a person attached at
the same time, are not coordinated. A turn stuck on a permission prompt looks
like `reply-pending`. After `delivery-unconfirmed`, the text may still be in the
session's composer; attach to inspect it.

Codex and AGY refuse with `unsupported-provider` until a same-session transport
is proven for them. Their `ManagedConversationRunner` resume starts a separate
CLI turn and is not a resident transport.

## A channel acknowledgement is not delivery

A notification channel that hands a frame to a live stream knows only that the
stream took it. It does not know that the far side's bridge kept it, that the
resident's session ever read it, or that any model was scheduled to look. An
idle Claude session drains its bridge only when it chooses to call the tool,
which an idle session never does — so a channel can answer `delivered: true`
at the same moment the message is going nowhere. This was measured, not
assumed: a report acknowledged as delivered never reached the idle session it
was addressed to, and had to be re-sent through the attach transport.

`deliverToResident` keeps that distinction. It sends over the caller's channel
first, because a channel does not interrupt a session that is already
listening, and then treats the acknowledgement as evidence rather than as an
outcome:

- `proves: "session"` — the channel proved the resident's own session recorded
  it. That is delivery, and nothing is woken.
- `proves: "stream"`, or no proof named at all — Drovr watches the resident's
  own transcript for the message and, if it never appears within
  `observationTimeoutMs`, wakes the resident through the proven attach
  transport. An absent `proves` is read as the weaker claim; the stronger one
  is never assumed.
- `delivered: false` — straight to the wakeup path, with no waiting.

The result says which path delivered (`channel-delivered`, `channel-observed`,
`woken`), or `undelivered` with the transport's own refusal when neither did.
A resident is never reported as having received something on the strength of a
transport acknowledgement alone.

The bias is deliberate: an unobserved message is re-delivered by waking, which
can duplicate a message that was received but not witnessed in time. A human
reading something twice is recoverable; a report silently dropped on the floor
of an idle coordinator is not.
