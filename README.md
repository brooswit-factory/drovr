# drovr

`@brooswit/drovr` is a wrapper around the [herdr](https://herdr.dev) SDK
(`@brooswit/herdr-sdk`) that this factory controls.

## What it is

herdr is the automation layer this factory's agents run on, and both
[`butchr`](https://github.com/brooswit-factory/butchr) (the software factory
daemon) and `candlestix` drive it directly through the SDK. drovr's job is:

1. to catch block situations herdr does not report, and
2. to override herdr's reporting where that reporting is wrong.

`@brooswit/drovr` is a **library**: you consume it by importing
`DrovrClient` into a TypeScript/JavaScript project, the same way you'd
import `HerdrClient`. It ships no CLI and no executable. If a `drovr`
program is on your `PATH`, it is a different, unrelated program — not this
package.

## Why it exists

butchr and candlestix both drive herdr. Without drovr, each of them would
have to solve the same herdr limitations separately, and probably
differently — the same class of bug fixed twice, in two different ways, or
fixed in one and not the other. drovr is the one place those fixes live. If a
fix would only ever work for one consumer, it's in the wrong shape; it
belongs in that consumer instead. Fixes that both consumers need belong here.

Some of the evidence behind that call:

- A new Claude Code dialog once froze a batch of epic agents for hours while
  herdr reported every one of them as idle or done. A blocked-agent detector
  that only reads herdr's own status has nothing to go on in that situation.
- After a host reboot, herdr has restored panes as a bare resumed session
  with no permission mode, no MCP config, and no channels — the agent looks
  alive and is useless.
- herdr has dropped agent names in some listings, which undercounts a
  running fleet if you count by name.
- A prompt can land in an agent's composer and never be submitted, which
  from the outside looks identical to a busy agent.

## Consuming drovr

`DrovrClient` is a drop-in replacement for `HerdrClient`: same services and
methods, with targeted report corrections. Unmatched results retain object
identity; original errors retain their instance and `isTimeout` behavior.
The event stream is unchanged. Migrating is the import and constructor call.

**Before:**

```ts
import { HerdrClient } from "@brooswit/herdr-sdk";

const herdr = new HerdrClient({ socketPath, timeoutMs });
await herdr.agent.list();
```

**After:**

```ts
import { DrovrClient } from "@brooswit/drovr";

const herdr = new DrovrClient({ socketPath, timeoutMs });
await herdr.agent.list();
```

`DrovrClient` is structurally assignable to `HerdrClient`, so a field typed
`private readonly herdr: HerdrClient` keeps compiling unchanged. Everything a
consumer needs from the SDK — `HerdrError`, `isTimeout`, `Subscription`, and
the generated/typed-escape-hatch types — is re-exported from `@brooswit/drovr`
too, so a migrated consumer never has to import from both packages.

## Agent selection

Drovr supports both **Codex** and **Claude**, and passes other agent kinds
through to Herdr as well. Select the agent with `agent.start({ kind: "codex",
name, pane_id, args })` or `kind: "claude"`. The caller supplies the existing
shell pane and arguments appropriate to that agent. Drovr does not translate
Claude flags into Codex flags, select a model, change authentication, or fall
back to a different provider after a failure.

Both kinds use the same `agent.prompt`, `agent.get`, `agent.read`, and
`agent.wait` methods. Herdr owns terminal interaction and base status detection;
the consuming application owns agent-specific instruction files, MCP
configuration, model selection, and permission policy. In particular, passing
through an agent kind does not imply support for another client's MCP channel
notifications. Each executable must be installed and authenticated locally.

`test/agent-kinds.test.ts` verifies typed startup and lifecycle forwarding for
both providers without launching agents or consuming model quota.

## The correction seam

Every service method call and every `call()` funnels through a single choke
point (`src/choke-point.ts`) that applies a per-wire-method correction
registry (`src/corrections.ts`). The default correction catches the current
Codex directory trust dialog when Herdr reports `idle` or `done`: a complete active
dialog on a raw visible pane read changes `agent_status` to `blocked` and
`interactive_ready` to `false`. It covers `agent.list`, `agent.get`,
`agent.start`, `agent.prompt`, and successful `agent.wait` results, including
their `call()` routes. It never presses keys or approves trust.

The correction is deliberately limited to idle/done Codex reports and this English
dialog layout. Read failures and nonmatches preserve the original result.
`wait` still waits on Herdr's own classification; Drovr cannot interrupt a
server-side wait or correct a thrown error. `start` and `prompt` are corrected
after their actions occur, so this is not a preflight input guard. Events,
session snapshots, and pane status reports remain raw. Consumers should poll
`agent.list/get` and inspect returned status before sending work or treating a
wait as successful; do not depend exclusively on events or readiness flags.
See [validation and release notes](docs/codex-trust.md) for exact limits.

`DrovrClient#raw` is the uncorrected escape hatch: `drovr.raw.agent.list()`
bypasses the registry regardless of what's registered for `agent.list`, so
you can always tell drovr's correction apart from herdr's own report.

Further corrections can be added to the registry. A custom `corrections`
option replaces defaults (`{}` disables them). See
[`docs/correction-seam.md`](docs/correction-seam.md) for how the registry
key is resolved, why it has to be the wire method name, how recursion
through a correction is bounded, and a full worked example of adding one.
