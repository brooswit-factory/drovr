# Conversation Handoff

Drovr owns provider selection and context transfer through two managed lifecycles:

- `ManagedConversationLifecycle` runs native CLI conversations (used by USRR).
- `ManagedHerdrLifecycle` runs terminal workers (used by Butchr).

Consumers provide workspace intent, ordered provider preferences, launch settings,
and persistence where applicable. They do not implement compaction or transcript
transfer. Use these lifecycle APIs instead of assembling provider replacements
from low-level start, prompt, and close calls. `ManagedConversationSession` is
the lower-level import transaction used internally by both lifecycles.

The operation snapshots history before starting a fresh target conversation. It
sends the history as quoted data in ordered chunks and asks the target to compact
it into working context without tools or task execution. Each response must begin
with `DROVR_HANDOFF_READY` followed by a nonempty working summary. Subsequent chunks
resume only the new provider's native ID. The source vendor never needs to answer.

Only after every chunk is acknowledged does the persistence callback run and the
new identity become current. Pending work is a separate message resumed on that
identity. A handoff failure leaves the source identity current; no source session
or transcript is deleted. Lifecycle operations serialize locally; Herdr instances
sharing a client and workspace share a queue. Separate processes must still have
a single owner of each workspace. Failed candidates may remain in provider history;
they are not automatically selected or deleted.

This is an instructed working-context summary, not transfer of proprietary native
state or a guarantee that the provider internally executes its `/compact` command.
The transcript must actually contain the desired history. Native history is
preferred, including attached terminal work. USRR's journal is used only if native
history is unavailable, not if it is unsafe or corrupt.
Do not substitute a terminal screenshot and claim it is a full transcript.

History is limited to 4 Mi characters and delivered in 48,000-character chunks.
Oversized histories fail explicitly rather than silently omitting older context.
No new Codex or Antigravity quota detectors are introduced. Unknown provider
errors remain errors, not permission to switch vendors.

`readNativeTranscript` can read a pinned native path, resolve a Claude session ID
inside its project directory, or locate a Codex rollout by session ID and matching
workspace header. Reads are bounded and reject symlinks or a changing file.
Antigravity uses its complete ordered `transcript_full.jsonl`; truncated display
transcripts are rejected. Herdr acknowledgements come from native model replies,
not terminal echoes or user messages. The source pane remains until the target
acknowledges and source identity and history are rechecked. Missing or ambiguous
source identity fails closed. Consumers must upgrade their dependency and use
the lifecycle APIs to receive this behavior.

Herdr terminal workers require its official provider integration to report native
session identity. Install the Codex integration with `herdr integration install
codex` and review that specific hook in Codex before unattended launches. Drovr
does not broadly approve arbitrary hooks. Private AGY homes can use
`prepareAgyHome({ home, cwd, servers, setupFromHome, installHerdrIntegration: true })`
to reuse completed onboarding/theme and install Herdr's official integration.
This does not copy source MCP identities, trust lists, or history. Butchr requests
this preparation for its isolated AGY workers.
