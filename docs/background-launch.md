# Background launch and blocking conditions

## Launching a background session

`launchBackgroundSession()` starts one detached provider session and returns
its identity as the provider's own listing reports it. A host calls this in
place of spelling `claude --bg` and parsing what it prints.

```ts
const result = await launchBackgroundSession({
  provider: "claude",
  cwd: "/srv/project",
  mcpConfigPath: "/srv/project/.mcp.json",
  mcpNotificationServers: ["yappr"],
});
// { ok: true, shortId: "582c43dc", sessionId: "582c43dc-f6cd-…", cwd, state }
// { ok: false, reason: "unsupported-provider" | "blocked" | "failed" | "unlisted", detail, blocking?, shortId? }
```

What Drovr owns so the caller does not:

- **Argument order.** Every option precedes `--bg`; `--bg` takes whatever
  follows it as the prompt, so a flag after it is silently demoted to prompt
  text. A prompt follows `--` so one starting with a dash stays a prompt.
- **Colour.** Claude Code sets `FORCE_COLOR` in every session and `claude`
  then colours piped output: the id arrives as `\x1b[36m582c43dc\x1b[39m`.
  Drovr runs the CLI without `FORCE_COLOR` and strips escapes before parsing.
- **Identity.** The short id is confirmed against `claude agents --json` and
  the full `sessionId` is taken from that listing, never derived or guessed
  from the directory. An id that never lists is `unlisted`.
- **MCP approval.** Servers in `mcpNotificationServers` and
  `mcpServersApproved` are approved at launch (`--settings
  {"enabledMcpjsonServers": …}`). A workspace's `.claude/settings.local.json`
  approval is ignored while the directory is untrusted, and the session would
  otherwise sit on "New MCP server found in this project".

A host that wraps launches (Bakr runs each inside its own `systemd-run --user
--scope`) injects `run(argv, cwd)` and prefixes its wrapper there. Drovr only
reads what the command prints.

After the id lists, Drovr reads the session's screen (`claude logs`) for
`settleMs` (default 4 s). A session stuck on a prompt is returned as
`blocked` with its `shortId` and `sessionId`, so the caller can stop or remove it.

Codex and AGY have no detached background session and refuse with
`unsupported-provider`.

## Blocking conditions

A blocking condition stops every agent on a host, not one turn.
`BlockingCondition.kind` names it:

| Kind | Measured | Seen as | Cleared by |
| --- | --- | --- | --- |
| `login-expired` | servyboi, 2026-09-17: all 16 agents died on their first call | transcript record `error: "authentication_failed"`, "Login expired · Please run /login" | `startClaudeLogin()` |
| `daemon-binary-replaced` | 2026-09-18: every background spawn crashed after an upgrade | `/proc/<daemon pid>/exe` ends ` (deleted)`; daemon log "daemon binary was deleted (upgrade in progress)" | an operator; see below |
| `mcp-approval-prompt` | claude 2.1.276, untrusted directory | session `state: "blocked"`, screen "New MCP server found in this project" | `mcpServersApproved` at launch |

- `classifyBlockingText(provider, text)` reads any provider output, with or
  without escapes.
- `classifyClaudeTranscriptRecord(record)` reads Claude's structured error
  tag, so a tool result that quotes the same words never matches.
- `probeClaudeDaemon()` and `daemonBlockingCondition()` check the shared
  daemon. `launchBackgroundSession` runs this check before every launch.
- `claudeLoggedIn()` reports stored credentials only. A token the server has
  expired still reads as logged in, so this proves a logged-out host, never a
  working one.

Drovr never stops the daemon for a caller. `claude daemon stop --any
--keep-workers` was measured NOT to preserve sessions through the next
takeover (adopt reported `dead=7`), so the remedy stays an operator's decision.

## Headless re-authentication

```ts
const login = await startClaudeLogin();          // spawns `claude auth login --claudeai` in a PTY
send(login.url);                                  // a human opens it in any browser
const result = await login.submitCode(pastedCode); // { ok: true } once `claude auth status` confirms
```

The login process is held open between the two halves. The browser is never
opened on the host. `cancel()` abandons the login and leaves stored
credentials as they were.
