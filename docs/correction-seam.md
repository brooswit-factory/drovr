# The correction seam

`DrovrClient` routes every herdr call through one internal choke point
(`src/choke-point.ts`). This document describes the correction registry
DROVR-6 hangs on that choke point: how to add a correction, why the seam is
shaped the way it is, and the traps a future change to this file or to the
`@brooswit/herdr-sdk` dependency could fall into.

This epic ships the mechanism only. **The registry is empty** — see
`src/corrections.ts`'s `defaultCorrections`. No method's result is corrected
today; `DrovrClient`'s observable behaviour is identical to `HerdrClient`'s.

## Adding a correction (worked example)

Say a later epic wants to correct `agent.list`: herdr reports an agent as
`idle` right after a dialog interrupts it, when it's actually blocked. The
whole entry is one addition to the registry in `src/corrections.ts`:

```ts
// src/corrections.ts
export const defaultCorrections: CorrectionRegistry = {
  "agent.list": async (result, ctx) => ({
    ...result,
    agents: await Promise.all(
      result.agents.map(async (agent) => {
        // ctx.client is the RAW hatch -- see "Recursion" below for why.
        const pane = await ctx.client.pane.read({ pane_id: agent.pane_id, source: "recent", format: "text" });
        return isActuallyBlocked(agent, pane.read.text) ? { ...agent, agent_status: "blocked" } : agent;
      }),
    ),
  }),
};
```

That's it — `defaultCorrections` is exactly what `DrovrClient` already
applies (`corrections ?? defaultCorrections` in `drovr-client.ts`), so
adding the entry in place is enough. Every consumer — `drovr.agent.list()`,
`drovr.call("agent.list", {})`, and anywhere reached through those two —
sees the corrected result with no consumer change and no name they'd need
to learn: that is the whole point (§4 property 2 below).

## Why the seam has this shape

The design — a per-wire-method result-correction registry applied
centrally at the choke point, identity as the default — was fixed by the
epic (DROVR-1) before this ticket, not chosen locally. Four properties, each
covered by a test that fails if it regresses (see `test/corrections.test.ts`
and `test/pass-through.test.ts`):

1. **Identity is the default.** A method with no registry entry returns
   herdr's result untouched, *by reference*. `createCorrectionChokePoint`
   (`src/corrections.ts`) enforces this structurally: when there's no
   matching entry it returns `invoke()` directly — not wrapped in an
   `async` function — so the settled promise, the resolved value, and any
   thrown error all come back exactly as `passThroughChokePoint` would
   produce them. Only a registered correction takes the `await`-and-rewrap
   path. This is what makes "this epic changed no behaviour" checkable by
   construction instead of by testing every one of the ~91 methods by hand.
2. **Registered by wire method name, applied centrally.** A later epic adds
   one registry entry (as above); no consumer changes, and no consumer ever
   learns which calls are corrected. This is the actual reason drovr exists
   as a separate package — see the README — so a design that leaked
   "corrected or not" into consumer code would defeat the point.
3. **A correction may be async and may itself call herdr**, via `ctx.client`
   — see the worked example above, and "Recursion" below for why
   `ctx.client` is `raw`, not the corrected client.
4. **A raw, uncorrected escape hatch** — `DrovrClient#raw` (see below).

### Alternatives the epic rejected

- **Fork/vendor the SDK.** Puts drovr on the hook for regenerating ~91
  methods by hand every herdr release. Rejected outright.
- **Subclass `HerdrClient`.** Services are constructed inside
  `HerdrClient`'s constructor and call a free `rpc()` function directly —
  there's no single inherited method every call passes through to override,
  so a subclass degenerates into re-listing methods one by one, which
  drifts the moment the SDK adds one.
- **Consumer-side helpers** (e.g. `drovr.correctedAgentList(herdr)`). Makes
  every consumer learn which calls are corrected — exactly the
  butchr/candlestix drift this package exists to prevent (see the README).
- **Supplement-only** (add new methods, never override existing ones).
  Insufficient: the founding case (see "Load" below) requires *correcting a
  value herdr already reports*, not adding a new one — a consumer still
  reading the old field would still be wrong.

## How the key is resolved, and why

**The registry is keyed on the wire method** — the string herdr's protocol
actually receives (e.g. `"agent.send_keys"`), never the JS method name
(e.g. `sendKeys`). This is not a preference; it's the only key property 2
above is satisfiable on, and the epic ruled on it directly.

Why it matters: the same wire call is reachable two ways —
`drovr.agent.sendKeys(p)` and `drovr.call("agent.send_keys", p)` — and they
used to arrive at the choke point under two *different* identities (the
first under the JS method name `sendKeys`, the second already under the
wire name). A registry keyed on whatever the choke point happened to
receive would correct one route and silently miss the other: nothing
throws, the call just doesn't get corrected. `test/corrections.test.ts`'s
"one registration corrects both the service-method route and the call()
route" test is what catches that regression; it was red under the JS-name
key and green under the wire-name key (verified by mutation while writing
this).

**Deriving the wire name from the JS name by convention doesn't work,
either** — `setView` maps to `agent.view.set`, not `agent.set_view`;
`clearView` to `agent.view.clear`; `events.subscribeAck` to
`events.subscribe`; `ui.notify` to `notification.show`; `server.ping` to
`ping`. No table or heuristic survives the SDK adding a method tomorrow, so
none is written here — that would reintroduce exactly the drift the
existing reflection-based design (`src/service-proxy.ts`'s dynamic service
and method discovery) was built to avoid.

### The mechanism: trapping `Service.prototype.call`

Every one of the SDK's service methods is a one-line delegation onto the
shared `Service` base class: `return this.call(wireMethod, params)`, and
`Service.prototype.call` is the last point drovr can reach before herdr's
own `rpc()` — the point where the service-method route and the `call()`
route actually converge on the same wire identity.

`src/service-proxy.ts`'s `wrapService` exploits that: instead of
intercepting the JS-level method call directly, it runs the real method
with a `this` whose *own* `call` property is trapped (`Object.create(t, {
call: { value: ... } })`). The method body still executes for real; when it
reaches `this.call(wireMethod, params)`, that resolves to the trap instead
of the inherited `Service.prototype.call`, handing the choke point the
exact wire method and params — no name table, no drift, and it's correct
for irregular mappings like `setView` for free because it never guesses.

If a method's body never reaches `this.call` — no trappable `call` on the
target at all, or the method just doesn't use it — the choke point is never
invoked for that call, and the method's own real result is returned as-is.
That's the deliberate, safe fallback: no wire name means no correction,
never a guessed key.

One instance of that fallback is deliberate rather than a gap: calling
`.call` itself on a wrapped service (`drovr.<service>.call(wireMethod,
params)`) no longer reaches the choke point — the `get` trap returns
`Service.prototype.call` unwrapped, because `call` isn't itself a
`this.call` delegation onto anything. This isn't a consumer-reachable hole:
`Service#call` is `protected` in the SDK's own types (calling it from
outside doesn't type-check without a cast), and it's declared on
`Service.prototype`, one level above each concrete service class, so
`enumerateSurface`'s reflection over a service's *own* prototype methods
never yields it — no route to a wire method that's actually part of
`DrovrClient`'s surface escapes a registration this way.

### What that depends on, and which test defends it

Recovering the wire name this way depends on every service method being a
thin delegation onto `Service.prototype.call`. That's true of the installed
SDK (`@brooswit/herdr-sdk@0.1.3` at the time this shipped) — but it is
**herdr's internal structure, not a contract herdr owes drovr.** If a future
SDK version ships one method that does something else before reaching
`this.call` (validates locally, short-circuits, whatever), wire-name
recovery breaks for *that* method specifically, and the likely failure mode
is a wrong-or-missing key, not a crash: a correction that silently stops
firing.

`test/choke-point-seam.test.ts`'s **"every method on the runtime surface
resolves to a wire name"** test is what defends against that. It enumerates
the live runtime surface (`test/support/enumerate-surface.ts` — the same
helper `test/parity.test.ts` uses, not a second copy) and asserts, **per
method**, that it produced exactly one wire-level identity at the choke
point — failing with the specific `service.method` that didn't, not just a
count mismatch. **If a correction stops firing after an SDK bump, this is
the test to check first** — a red result here, naming the method, means
that method no longer reaches the `this.call` trap, and the registry
silently degrades to pass-through for it (never a guessed key) until this
test is fixed or the mechanism is revisited.

## Recursion: bounded by construction, not a counter

A correction that calls back into herdr (property 3) must not be able to
re-enter its own corrector, or any corrector, forever. `DrovrClient#raw` is
what makes that structural rather than a depth counter that could be gotten
wrong: `raw` is a `DrovrClient` sharing the same inner herdr client but
wired to `passThroughChokePoint`, so it never consults the registry at all.
`ctx.client` (see `src/corrections.ts`) is always `raw` — never the
corrected client — so a correction calling `ctx.client.agent.list()` reaches
herdr exactly once more, regardless of which method it's correcting or
which method it calls back into. `test/corrections.test.ts`'s "a correction
calling back into its own method via ctx.client terminates instead of
recursing forever" test proves this: it asserts the inner client saw
*exactly two* real calls, not an unbounded chain (verified by mutation:
pointing `ctx.client` at the corrected client instead of `raw` hangs the
test instead of failing it cleanly, which is the observable signature of
unbounded recursion rather than a clean assertion failure).

`raw` is also the answer to "is herdr still wrong about this?" — without
it, a correction is indistinguishable from herdr's own report from outside,
and every correction becomes permanent by default (§4 property 4). A
`DrovrClient`'s own `.raw` bottoms out at itself (`raw.raw === raw`) rather
than constructing a fresh raw client underneath it every time one is built.

## `subscribe()` is outside the seam

`DrovrClient#subscribe` passes straight through to the inner client's
`subscribe()`, unchanged, deliberately outside the choke point. It opens
its own long-lived socket connection and never goes through `rpc()` the way
every service method and `call()` do, so there's no discrete per-call
result to intercept — nothing in this registry corrects event-stream
frames. If a later epic needs to correct the event stream, that's new
design work, not something this seam already covers; DROVR-5 flagged this
explicitly and DROVR-6 didn't change it.

## The load this design is rated for

This seam isn't solving any of these — they're the motivating cases that
settled the shape above:

- **The founding case.** On 2026-08-30, a new Claude Code dialog froze five
  epic agents for twelve hours while herdr reported every one of them as
  idle or done. butchr's only blocked-agent detector reads herdr's own
  status field, so nothing downstream ever ran. Deciding "actually blocked"
  needs more than the `agent.list` result alone (pane content, at least) —
  which is why a correction can be async and call back into herdr (property
  3), and why a synchronous `result => result'` seam couldn't have carried
  this case.
- **Bare resumed sessions after a reboot.** herdr has restored panes as a
  bare `claude --resume` with no permission mode, no MCP config, and no
  channels. The agent looks alive to herdr and is useless.
- **Dropped agent names.** herdr 0.8 dropped agent names in some listings,
  which undercounts a running fleet if something counts agents by name.
- **Composer text that never submitted.** A prompt can land in an agent's
  composer and never be submitted, which looks, from outside, identical to
  a busy agent.

Corrected detection for these is explicitly **out of scope for this epic** —
DROVR-10/DROVR-6 builds only the seam. Block detection that doesn't depend
on herdr's classification, and corrected agent enumeration/counting, are
separate, already-filed epics that will register their corrections here.
