# Hosting residents in herdr panes

A resident is a long-lived interactive provider session that other agents
reach by channel frames. Drovr hosts each one in its own herdr workspace pane
rather than as `claude --bg`: measured on claude 2.1.276, a background session
never shows the development-channels confirmation and never delivers a channel
frame as a turn, while the same session in a terminal pane does.

```ts
const hosted = await hostResident(client, {
  provider: "claude",
  cwd: "/srv/project",
  label: "lead-drovr",             // unique on the host: the herdr agent name
  inputs: { mcpConfigPath: "/srv/project/.mcp.json", mcpNotificationServers: ["yappr", "rocketr"], mcpServersApproved: ["yappr", "rocketr"] },
  resume: "6698ea62-…",            // optional: continue this session
  prompt: "Resume your work.",     // optional: first turn
});
// { ok: true, paneId: "w2:p1", workspaceId: "w2", sessionId, promptError? }
// { ok: false, reason, detail, paneId?, excerpt? }

await listResidents(client);        // [{ paneId, workspaceId, label, provider, sessionId, cwd, status }]
await stopResident(client, "w2:p1"); // closes the workspace; the transcript stays for `resume`
```

What Drovr owns so the host does not:

- **A unique agent name.** herdr refuses a second agent under a name already
  in use, and accepts only 1–32 lowercase letters, digits, `-` or `_`. The
  label is that name. It is checked before anything is created, so a taken
  label (`label-taken`) or a bad one (`invalid-label`) never costs a running
  session its pane.
- **A shell that is still starting.** A new workspace's shell can refuse
  `agent.start` as "not an available shell"; that refusal alone is retried,
  for up to 10s.
- **Startup prompts.** Folder trust and the development-channels warning are
  answered by reading the menu's cursor off the screen and moving it onto the
  accepting option. Measured on claude 2.1.x the trust menu is drawn
  unnumbered with the cursor on "No, exit", so a fixed key sequence is not
  assumed. An MCP approval prompt is not answered: approval travels on the
  launch (`mcpServersApproved`), and the refusal says so. Any other prompt is
  `blocked-prompt` with the screen excerpt.
- **The first turn.** `prompt` is submitted with `agent.prompt` once the input
  box is ready, never as an argv prompt: a positional prompt given alongside
  the startup confirmations never became a turn. A refused first turn is
  `promptError` on a successful result; the resident is not closed for it.
- **A resume with nothing to resume.** A session that never took a turn has no
  transcript; `claude --resume` prints "No conversation found" and exits.
  That is `no-such-session` at once, not a timeout. The text "This
  conversation is from a different directory" is in Claude's binary, and a
  screen showing it is `wrong-directory` rather than an unknown prompt. It
  has never been observed on a screen: bakr inferred it for a session that
  moved into a worktree, then withdrew the claim, and claude 2.1.277 resumed
  a proof session from both a child and an unrelated sibling directory
  without refusing.
- **Two hosts racing for one label.** Both can pass the free-name check; herdr
  then refuses the second `agent.start` (`agent_name_taken`), and that host
  closes its own workspace. Proven live: exactly one pane holds the name.
- **Cleanup.** Every failure after the workspace exists closes it, so no
  half-started pane keeps an MCP identity or the agent name.

`listResidents` and `stopResident` only see workspaces labelled
`drovr <label>`, so a stale pane id can never close another host's workspace
(`not-hosted`).

Only Claude residents are hosted so far (`unsupported-provider` otherwise).

## Proof

`scripts/verify-host-resident.ts` runs the whole cycle (host with both startup
prompts, refuse the duplicate label, list, first turn, stop, resume the same
session, stop, then two labels hosted in parallel and two hosts racing for
one label) against an explicitly named `drovr-proof-*` herdr session. Start
that server without the calling Claude session's `CLAUDE*` environment: a pane
that inherits `CLAUDE_CODE_CHILD_SESSION` does not save its transcript, so
nothing can be resumed from it.
