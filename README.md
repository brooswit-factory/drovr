# drovr

`@brooswit/drovr` is a wrapper around the [herdr](https://herdr.dev) SDK
(`@brooswit/herdr-sdk`) that this factory controls.

## What it is

herdr is the automation layer this factory's agents run on, and both
[`butchr`](https://github.com/brooswit-factory/butchr) (the software factory
daemon) and `candlestix` drive it directly through the SDK. drovr's job is:

1. to catch block situations herdr does not report, and
2. to override herdr's reporting where that reporting is wrong.

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

Coming in the next story — drovr does not yet wrap or override anything.
This package is currently a scaffold: a build, a dependency on
`@brooswit/herdr-sdk`, tests, and CI.
