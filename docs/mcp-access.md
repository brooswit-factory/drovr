# MCP access

One declaration of intent — "this agent may use yappr" — rendered into each
vendor's own dialect. A caller states it once; Drovr owns the mapping, the
ordering, and the restart, the same way it already owns permission modes.

```ts
const declaration = {
  cwd: "/home/brooswit/code/brooswit-factory/yappr",
  servers: [{ name: "yappr", notifications: true }],
};
await setMcpAccess("claude", declaration, { stop, released, start });
```

## What each vendor actually needs

Measured, not assumed — each of these was a separate manual fix for a single
logical intent, and each failure below is one that was observed:

| Vendor | Where access lives | Symptom when it is missing |
| --- | --- | --- |
| claude | `<cwd>/.claude/settings.local.json` → `enabledMcpjsonServers` | The session sits `blocked` on an approval prompt nothing can answer, and its identity never registers at all. |
| agy | `<home>/.gemini/antigravity-cli/settings.json` → `permissions.allow: ["mcp(<server>/*)"]` | Headless AGY auto-denies every MCP call and still answers `SUCCESS` with an empty `response` and a populated `denied_actions`. |
| codex | `--config mcp_servers.<name>=…` at process start | No servers. |

Naming `tools` narrows AGY's permission to exactly those tools
(`mcp(yappr/yappr_send)`); omitting it grants the whole server. Keys the
declaration does not govern are preserved, and settings that cannot be parsed
are refused rather than overwritten.

## The three ordering rules

**A write alone is a no-op for a running agent.** Every vendor reads all of
this at process start. `applyMcpAccess` reports `restartRequired` exactly when
a file changed, and `setMcpAccess` restarts rather than pretending the write
landed. A Claude session already blocked on an approval prompt is the sharp
case: no later write can rescue it.

**A provider switch provisions the target vendor first.**
`switchProviderMcpAccess` writes the target's settings before its first process
starts — the same ordering the conversation lifecycle already keeps for native
identity and history import. Reversed, the first turn on the new provider comes
up with no tools and, on AGY, silently succeeds with empty output.

**Readiness waits on a verified release, never a sleep.** A single-holder
identity (one connection per identity) whose holder died without being reaped
stays registered: every new bridge is refused, the model sees zero tools, and
the symptom is indistinguishable from broken MCP configuration. Clearing it by
restarting the whole service wipes every other identity's registration as
collateral. So `awaitIdentityRelease` asks a real question on a deadline and
throws `IdentityStillHeldError` rather than declaring a new agent ready while
the old holder is still there. A sleep long enough to usually work is also a
sleep that lies when it does not.

## Idle inbound addressability is not a configuration problem

Outbound from a resident conversation works and is verified end to end: a
`yappr_send` from the resident was drained from the recipient's own buffer.

Inbound to an *idle* agent does not, and no settings file can fix it. The
identity is registered by the ephemeral provider child Drovr spawns per turn,
or by an interactive attach. Between turns, nothing holds it, so a send to an
idle agent is refused `offline` — the layer whose purpose is to be durable and
addressable is unaddressable exactly when it is idle.

Making an idle agent addressable requires the persistent daemon to hold the
connection instead of the per-turn provider process. That is a design decision
about where the identity lives, not a bug in anyone's configuration, and it is
recorded here as open rather than quietly worked around.
