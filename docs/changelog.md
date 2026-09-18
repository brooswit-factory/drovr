# Changelog

## 0.10.2

- `listBlockingPrompts` and `classifyBlockingScreen`: every dialog a Claude
  pane is waiting on, read from its screen whatever herdr reports, tagged
  `startup`, `permission` or `unknown` with pane, label, session and excerpt,
  so a host can answer what Drovr knows and alert a person on the rest. A
  dialog counts only when its waiting footer is on screen. Its first live
  read-only run found three panes on the auto-mode menu that herdr reported
  idle or done.
- Finish the auto-mode setup on an account that already has entries: "You
  already have auto-mode entries" gets "Add to them" (never "Start fresh",
  which would replace them), and the review of the generated environment gets
  "Looks good — save it", so each agent's view adds to the account's. Both
  measured on yappr-3's pane, 2026-09-18; the save was the manager's decision
  under Brooswit's "always Yes".

Release asset: `brooswit-drovr-0.10.2.tgz`.

## 0.10.1

- Answer Claude Code's "Teach auto mode about your environment?" menu the way
  Brooswit chose: "Yes", then on the setup screen tick both "Also scan shell
  history" and "Also scan your other repos" (usage left as shown), then
  Continue. One step per screen read, so Continue is pressed only once the
  screen shows both boxes ticked. Space as the toggle key is not yet observed
  live; if it does not tick a box, Continue is never pressed and the launch
  ends `not-ready` with the excerpt. Measured on lead-factory-dashboard's and
  nexus-admin's panes, 2026-09-18. Claude shows this menu only while
  `autoMode.environment` in `~/.claude/settings.json` is empty, so once the
  setup has run for an account it does not appear again.
- Read a menu's own cursor: the `❯` nearest above its "Enter to confirm"
  footer. A live or resumed pane also shows transcript prompts above a menu
  and its input box below it, and taking the first `❯` on screen would have
  closed a resumed trust dialog as `unknown-blocking`.

Release asset: `brooswit-drovr-0.10.1.tgz`.

## 0.10.0

- Host residents in herdr panes: `hostResident`, `listResidents` and
  `stopResident` (see `docs/resident-host.md`). The label is the herdr agent
  name and is checked free before anything is created: on 2026-09-18 bakr
  started every pane as `claude`, and seven agents lost their panes to the
  name collision. Startup prompts are answered from the menu drawn on screen,
  and the first turn is sent once the input box is ready. Proven live against
  an isolated herdr session, including a resume of the same session.
- Confirm delivery of a long message. Claude Code records a long bracketed
  paste as `<pasted_content id="…">…</pasted_content id="…">` instead of the
  pasted text, so every long send reported `delivery-unconfirmed` although it
  had landed (measured on rocketr's resident, session 517fd13a). The messenger
  now also accepts exactly one such block wrapping the sent text, and nothing
  else in the record.
- Approve a pending tool-permission prompt without a terminal:
  `listPendingPermissions` and `approvePermission` (see
  `docs/permission-approval.md`). The prompt is re-read and refused if it
  changed since the operator saw it, an audit record is written before any
  key is sent, the auto-mode option is never chosen, and success means the
  prompt left the screen. Proven live on a real Bash prompt.
- Reach a resident that is busy only with background workers. Claude lists a
  session `busy` for as long as a Monitor runs, so every agent with a watcher
  refused every send. `claudeResidentActivity` reads the transcript: a session
  whose last conversation record closed its turn is `background` and takes the
  message; one still mid-turn is refused as `busy`, as before. Only Claude's own
  `busy` can become `background`: a session listed `blocked` (stopped on a
  dialog) is refused as `blocked`, and any other status as `busy`.
- `listResidents` reports each resident's provider `pid` (the pane's foreground
  process named after the provider, never the shell), for a host's own
  liveness check.

Release asset: `brooswit-drovr-0.10.0.tgz`.

## 0.9.2

- Join each Claude channel to its flag. With more than one channel,
  `--dangerously-load-development-channels server:yappr server:rocketr` let
  `claude --bg` take the second value as the session's first prompt, even
  before `--bg`. Measured on claude 2.1.276: the session began with the
  literal turn "server:rocketr", never registered the channel, and
  Rocket.Chat DMs pushed to it were dropped. `buildProviderLaunchArgs` now
  emits one `--dangerously-load-development-channels=server:x` per channel.
  `checkManagedAgentArgv` reads both spellings, so a process launched by an
  older build is not reported as drifted.

Release asset: `brooswit-drovr-0.9.2.tgz`.

## 0.9.1

- Send to a never-prompted resident. A fresh background session lists with no
  `status` at all. The messenger read that as busy and refused every send
  (measured on factory-dashboard's resident for 6+ minutes). An absent status
  is now checked against the session's screen: the session counts as idle
  unless the screen shows a blocking prompt. A blocking prompt is refused with
  the new `blocked` reason, rather than answered by a typed Enter.
- Find a resident's transcript by session ID. When a session enters a git
  worktree, Claude moves its whole transcript to the worktree's project
  folder. Reads by launch directory then failed with "saved history is
  unavailable" after a delivery that had succeeded, and `deliverToResident`
  saw nothing. `readClaudeTranscriptTail` now finds the file wherever it is,
  and the messenger finds the session by its UUID at its current listed cwd.

Release asset: `brooswit-drovr-0.9.1.tgz`.

## 0.9.0

- Add `launchBackgroundSession`, so a host starts a Claude background session
  through Drovr and gets back a clean `shortId` and the listed `sessionId`
  instead of parsing `claude --bg` output itself. Options always precede
  `--bg`, output is read without `FORCE_COLOR` and with escapes stripped, and
  the id is confirmed against `claude agents --json`. See
  [background launch](background-launch.md).
- Add `BlockingCondition` for host-wide provider conditions, each measured:
  `login-expired`, `daemon-binary-replaced`, and `mcp-approval-prompt`.
  `launchBackgroundSession` refuses before launching when the daemon runs a
  deleted executable. It reports a session stuck on a prompt as `blocked`
  and returns the session's id so the caller can clean it up.
- Add `startClaudeLogin` for headless re-authentication. The authorize URL
  is relayed out and the pasted code relayed back into the same PTY, and the
  result is proven by `claude auth status`.
- Add `mcpServersApproved` to `ProviderLaunchInputs`. For Claude it becomes
  `--settings {"enabledMcpjsonServers": …}`, which holds in an untrusted
  directory where a workspace `settings.local.json` approval is ignored.
- `runConversationProcess` no longer passes `FORCE_COLOR` to the CLI it parses.
- Accept AGY 1.2.5's own full transcripts, which 0.6.0 rejected as "incomplete
  or has an unsupported record" and so broke USRR history and provider
  handoff. Measured on this host's transcripts, AGY writes records in
  completion order, reuses an interrupted turn's step index, never writes
  some steps, and omits `content` on tool-only planner steps. 14 of 21 were
  rejected before this change and all 21 are accepted after it. Completeness
  now rests on AGY's own signals: a partial final record, or
  `truncated_fields`. `nativeTranscriptReply` takes AGY's reply from the
  highest step instead of the last line.

- Drovr owns MCP access across vendors: one `McpAccessDeclaration` renders into
  Claude's `enabledMcpjsonServers`, AGY's `permissions.allow: ["mcp(<server>/*)"]`
  and Codex's start arguments. `setMcpAccess` provisions then restarts, because
  every vendor reads this at process start; `switchProviderMcpAccess` provisions
  the target before its first process starts; both gate readiness on
  `awaitIdentityRelease`, a real check with a deadline, never a sleep. See
  [MCP access](mcp-access.md).
- Report subscription as its own launch-time act: `restart: "fresh-launch"`
  when a running process lacks a declared channel, since a respawn carries no
  arguments and can never apply one, and `subscriptionUnverified` when the
  caller has not said what the process was launched with. `notificationSupport`
  states the ceiling — AGY and Codex are the wrong runtime, headless Claude has
  no acceptor, and even a supported session needs a human to accept each frame.
- Refuse an AGY turn that answers `SUCCESS` with an empty response and a
  populated `denied_actions` (`AgyDeniedActionsError`), instead of persisting a
  denied turn as an assistant turn that said nothing.
- Add `deliverToResident`, which refuses to read a notification channel's
  transport acknowledgement as delivery to a resident. A stream-level ack is
  confirmed against the resident's own transcript and, when the message never
  appears, the resident is woken through the proven attach transport. Fixes
  reports acknowledged as delivered that an idle session never received.

Release asset: `brooswit-drovr-0.9.0.tgz`.

## 0.8.0 (never published)

Built and shipped by hand to servyboi; everything below first shipped in a
published release as 0.9.0.

- Own configurable MCP servers and development channels at the Drovr boundary.
  `mcpConfigPath` and `developmentChannels` are provider-neutral launch inputs
  accepted for Claude, Codex, and AGY, and `ManagedHerdrStartRequest` accepts
  both so a caller states them once per request. Claude receives `--mcp-config`
  and `--dangerously-load-development-channels`; other providers take the same
  inputs without Claude-specific coupling.
- Merge development channels instead of replacing them, so a request that adds
  one channel keeps the channels its launch already configures. Duplicates
  collapse, first-mention order is kept, and `mergeDevelopmentChannels` is
  exported for callers combining lists themselves. `checkManagedAgentArgv` now
  checks every configured channel against a live process rather than the first.
- Add `buildProviderLaunchArgs` for callers that spawn a provider CLI directly
  instead of going through Herdr, so Claude's flags stay inside Drovr. Neutral
  `ProviderLaunchInputs` name an MCP config path, the MCP servers whose
  notifications a session needs, and any already-spelled channels; Drovr maps
  each notifying server to `server:<name>` for Claude and to nothing for Codex
  and AGY. `ManagedAgentLaunch` and `ManagedHerdrStartRequest` accept
  `mcpNotificationServers` on the same terms, and the Herdr adapter now builds
  its Claude arguments through the same function.

## 0.7.0

- Add provider-neutral `createResidentAgentMessenger` for sending one message to a
  running resident and reading its reply. Claude sends through `claude attach` in a
  PTY and proves delivery and reply from that session's own transcript. It never
  resumes or forks. Codex and AGY refuse with `unsupported-provider`.
- Add `readClaudeTranscriptTail` for incremental reads of live Claude transcripts.
  A session that has never been prompted has no transcript yet; reading it from
  offset 0 returns empty text, so a freshly created resident can take its first
  message.

See [resident agent messaging](resident-agent.md).
Release asset: `brooswit-drovr-0.7.0.tgz`.

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
