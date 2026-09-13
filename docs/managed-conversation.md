# Direct conversation runtime

`ManagedConversationRunner` is a direct structured CLI conversation transport for
AGY, Codex, and Claude. It does not use Herdr or change the managed worker runtime.

```ts
import {
  ManagedConversationRunner,
  type ManagedConversationRunnerOptions,
  type ManagedConversationResult,
  type RunProcess,
} from "@brooswit/drovr";

const runner = new ManagedConversationRunner({
  provider: "agy",
  cwd: workspace,
  permissionMode: "accept-edits",
});
const first = await runner.message("Hello");
const next = await runner.message("Continue", first.conversationId);
const argv = runner.attachArgv(next.conversationId);
```

`ManagedConversationRunnerOptions` requires `provider: ManagedAgentProvider` and
`cwd: string`. Its optional `permissionMode: string` maps `yolo` and `plan`
explicitly; other values, including omission, use `accept-edits`, preserving the
old USRR AGY adapter. It does not read USRR environment variables; consumers pass
their configured mode. `run?: RunProcess` replaces the default process adapter:

```ts
type RunProcess = (
  argv: readonly string[], cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
```

`message(text, conversationId?)` returns `Promise<ManagedConversationResult>`, where
the result is `{ conversationId: string; response: string }`. IDs are taken from
the provider output. An explicit resume must return the same ID or the call fails.
`attachArgv(id)` returns interactive arguments without launching a process. Launch
them in the runner's cwd; Codex also receives an explicit `--cd` argument.

| Provider | Message transport | Resume | Interactive attach |
| --- | --- | --- | --- |
| AGY | `--output-format json --print` | `--conversation ID` | `--conversation ID` |
| Codex | `exec --json --skip-git-repo-check` | `exec resume ID` | `resume ID` |
| Claude | `--output-format json --print` | `--resume ID` | `--resume ID` |

AGY retains its `--mode accept-edits`, `--mode plan`, or
`--dangerously-skip-permissions` arguments. Claude maps these modes to
`--permission-mode acceptEdits`, `--permission-mode plan`, or
`--dangerously-skip-permissions`. Codex uses `workspace-write` or `read-only`
sandboxing, with approvals `never` for noninteractive messages and `on-request`
for interactive attach; `yolo` uses `--dangerously-bypass-approvals-and-sandbox`.
These mappings do not assert identical permission policies between providers.

The default `runConversationProcess` adapter starts argv directly, ignores stdin,
and drains stdout/stderr concurrently. It has the original USRR adapter's
process-lifetime behavior: no additional timeout or output-size limit. Consumers
that need those bounds can inject an adapter. Neither constructing the runner nor
building attach arguments prepares workspace trust or edits provider configuration.

## Selection and errors

USRR owns the `agy,codex,claude` priority and uses Drovr's existing account registry
and `runWithProviderFallback` for known availability. Persist both provider and
native conversation ID. A saved ID belongs to that provider, regardless of later
priority changes. Each runner is bound to one provider and does not switch.

Errors from nonzero exits, thrown process adapters, invalid output, or failed turns
are sanitized `Error` instances without raw stdout, stderr, nested causes, or quota
classification. Preserve saved session state when a call fails. The existing
Claude pane classifier is not applicable evidence for arbitrary structured CLI
errors and is not invoked here. A provider's failure must not be converted to a
quota refusal by matching exception text.

## Verification

Installed help inspected on 2026-09-12: AGY `--help`, Codex
`0.154.0-alpha.6.2` main/exec/exec-resume/resume help, and Claude Code `2.1.269`
`--help`. No live probe is part of the normal test suite.
Interactive attach arguments are help-verified and fixture-tested; no TUI attach
was launched during this verification.

- AGY argument construction and `SUCCESS`/`conversation_id`/`response` parsing
  preserve the existing USRR `src/agy.ts` adapter and its injected tests.
- A live minimal Codex initial message and resume both succeeded. JSONL contained
  `thread.started` with the same native `thread_id`, `item.completed` with an
  `agent_message.text`, and `turn.completed`. The adapter returns the last completed
  agent message and requires a completed turn. Tool and reasoning output are not
  included in the response. Probe-only user-config/rules suppression was used to
  isolate the check; the shipped adapter uses the caller's normal configuration.
- Claude's live minimal probe returned exit 1 and a structured `type: result`
  containing `session_id`, `result`, `is_error: true`, and `subtype: success`.
  A live resume accepted the same native ID and returned the same structured
  failure shape. Therefore subtype alone is not a success condition. Successful
  Claude results remain fixture-tested, not verified by a successful live turn on
  this account. No quota exception is inferred from that failure.

Tests cover explicit new/resume/attach argv, permission modes, unchanged native
IDs, malformed and failed output, safe errors, and the actual process adapter
using local Bun subprocesses without invoking model providers.
