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
| `not-running` | The exact session is not a running background session in `cwd` |
| `busy` | The session is mid-turn |
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
   entry with the same `cwd` and `status: "idle"`. Attaching an absent job
   wakes it, so absence is refused before any attach.
2. Records the transcript end, opens `claude attach` in a PTY, waits for output
   to settle, sends the message as a bracketed paste, then Enter.
3. Counts delivery only when a user record with exactly that text appears in
   `~/.claude/projects/<cwd>/<sessionId>.jsonl`, then detaches by stopping the
   attach client. The background session keeps running.
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
