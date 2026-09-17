# Changelog

## Unreleased

- Add provider-neutral `createResidentAgentMessenger` for sending one message to a
  running resident and reading its reply. Claude sends through `claude attach` in a
  PTY and proves delivery and reply from that session's own transcript. It never
  resumes or forks. Codex and AGY refuse with `unsupported-provider`.
- Add `readClaudeTranscriptTail` for incremental reads of live Claude transcripts.

See [resident agent messaging](resident-agent.md).

## 0.4.0

- Add `ManagedConversationRunner` for direct AGY, Codex, and Claude CLI messages
  and native conversation resume, with an injectable `RunProcess` adapter and
  interactive `attachArgv`. This API is separate from Herdr-managed workers.
- Preserve USRR's AGY permission and JSON argument behavior; map Codex JSONL and
  Claude JSON results to `{ conversationId, response }`. Reject incomplete turns,
  failed results, and changed resume IDs without exposing process diagnostics.
- Leave provider selection, saved provider/ID pairs, and known account availability
  to consumers. No quota classification or cross-provider resume is added.
- Export `startManagedAgent` and `AgentShellReadinessError` for bounded retries
  of Herdr's explicit pre-launch `agent_pane_busy` refusal, with sanitized
  readiness diagnostics. Other launch failures propagate unchanged.

See [conversation runtime](managed-conversation.md) for API and verification limits.
Release asset: `brooswit-drovr-0.4.0.tgz`.

## 0.3.2

- Add `prepareManagedAgentWorkspace({ provider, cwd, unattended }, settingsPath?)`.
  For unattended AGY launches, trust the exact existing realpath directory in
  `~/.gemini/antigravity-cli/settings.json`. Root, home, and ancestors of home
  are refused. Other providers and attended launches are no-ops.
- Preserve other settings and trust entries, reject malformed settings without
  overwriting them, serialize calls within the process, and replace settings
  atomically using a private temporary file. Tests use isolated fixture settings.
- Keep workspace preparation separate from `buildAgentStartParams`:
  `--dangerously-skip-permissions` does not dismiss AGY's workspace trust screen,
  and trusting a parent directory does not trust its children.

Release asset: `brooswit-drovr-0.3.2.tgz`.

## 0.3.1

- Add `AgyAgentLaunch.skipPermissions?: boolean` and export the launch type from
  the package entry point. Explicit `true` adds `--dangerously-skip-permissions`
  to AGY launch arguments; omitted or false preserves the existing behavior.
- Clarify that AGY inherits cwd from its pane and uses external MCP configuration,
  including stdio-to-HTTP bridges. No cwd, MCP, or workspace-trust flags are added.

Release asset: `brooswit-drovr-0.3.1.tgz`. Consumers must update their dependency
URL and lockfile after the matching `v0.3.1` GitHub release is published.
