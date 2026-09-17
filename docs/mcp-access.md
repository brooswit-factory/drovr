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

## Subscribing is a separate act from enabling, and a launch-time one

Enabling a server lets an agent *call* it. Being woken by it is a different
act: a launch-time argument naming the server's development channel. Drovr
reports the difference as `restart`:

| `restart` | What it means | What satisfies it |
| --- | --- | --- |
| `none` | Already as declared | Nothing |
| `restart` | Enablement changed on disk | Any restart, including a respawn |
| `fresh-launch` | A subscription the running process lacks | A fresh launch or fork **only** |

A respawn carries no arguments, ever. A caller that respawns to pick up a
subscription gets a session that looks restarted and is still not subscribed —
measured: `off`/`on` resumed the same session id and changed nothing.

When the caller does not say what the running process was launched with,
`subscriptionUnverified` is true and `restart` stays driven by the files alone.
Unknown is a third answer on purpose: guessing "unsubscribed" would demand a
fresh launch on every call and never converge, and guessing "subscribed" would
reproduce the bug this is here to catch.

## The ceiling: most agents can never be woken

`notificationSupport(provider, runtime)` states this rather than emitting a
flag that does nothing:

- **AGY and Codex: never.** Rendering a channel frame is Claude Code's
  behaviour. It is the wrong runtime, not a missing setting.
- **Headless Claude (`--print`): never.** No acceptor exists for the frame's
  prompt, and print mode skips channels.
- **Interactive Claude, freshly launched with its channels: supported** — and
  still carrying a caveat that Drovr states rather than hides: each frame needs
  a human to accept its prompt, so an unattended session may never render one.

So "channel delivery for everyone" is not achievable and Drovr does not claim
it. Everything else is poll-only: it reads its buffer when something else
prompts it.

**Therefore the "poke an idle agent through the channel" pattern does not
work**, and Drovr does not offer it. A poke to an idle agent lands in a
bounded, ephemeral buffer that nobody will drain. The mechanism that does work
on an idle Claude session is `deliverToResident`: it types into the session's
own attach terminal and proves delivery from that session's transcript. Use a
channel for an agent that is already listening; use the resident transport to
wake one that is not.

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
about where the identity lives, not a bug in anyone's configuration.

**The decision: the persistent daemon should hold the connection, and a
per-turn provider child should not register the durable identity at all.**

The reasoning is that a per-turn child cannot make a durable identity
addressable no matter how it is configured — the lifetime of the registration
is the lifetime of the process, and the whole purpose of the layer is to
outlive its agents. Registering from the child also actively harms: it takes
the single per-identity connection slot, so the moment that child dies without
being reaped, every later connection is refused and the model reports zero
tools (see the release rule above).

This moves identity ownership out of Drovr's per-turn spawn and into the
daemon that already runs continuously, so it is not Drovr's change to land
alone. Recorded here as decided, not done.
