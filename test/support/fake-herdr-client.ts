import { HerdrClient } from "@brooswit/herdr-sdk";

export interface RecordedCall {
  readonly service: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeHerdrClient {
  readonly client: HerdrClient;
  readonly calls: RecordedCall[];
}

/**
 * Builds a herdr-client-shaped fake by reflecting over a real `HerdrClient`
 * instance. Constructing `HerdrClient` never opens a connection (it just
 * holds options, per the SDK's own doc comment on the class), so this
 * never touches a socket.
 *
 * Every service field becomes an object with the real service's PROTOTYPE
 * (so it's recognized as a "service" the exact same way
 * `src/service-proxy.ts` recognizes a real one, and so its real methods —
 * `sendKeys`, `setView`, ... — are the genuine SDK code, unstubbed). The
 * ONLY stub is `call` itself, as an own property overriding the inherited
 * `Service.prototype.call` — exactly mirroring how the real SDK's services
 * are thin delegations onto `Service.prototype.call` (see
 * `src/service-proxy.ts`'s doc comment). That's what lets this fixture
 * reach `src/`'s `this.call`-trap mechanism at all: a fixture that instead
 * stubbed each method directly (as this one used to) never calls `this.call`
 * for anything, so a `this.call` trap sees no wire name for ANY method —
 * measured `false` for "does the fixture reach `this.call`" before this
 * fix (DROVR-6, DROVR-10).
 *
 * Discovered entirely by reflection: no service or method name is written
 * here, on purpose, mirroring the drift-proofing the ticket requires of
 * `src/` itself, so this fixture doesn't quietly go stale either.
 *
 * `calls` is returned alongside `client`, not attached to it — attaching
 * test bookkeeping directly onto the object passed as `herdr:` would make
 * it just another own property for `wrapServices` to discover and treat
 * as a pass-through field, which isn't what a real `HerdrClient` ever has.
 *
 * `call`/`subscribe` live on a PROTOTYPE here, not as own properties of
 * `client` — matching the real `HerdrClient`, where they're regular class
 * methods (own properties only cover its instance fields: `opts` plus the
 * 12 services). That distinction matters: `DrovrClient`'s constructor does
 * `Object.assign(this, wrapServices(this.inner, ...))`, and `wrapServices`
 * passes through anything on `inner` that isn't "service-like" — including,
 * for a fixture that (as this one used to) puts `call` directly on the
 * `client` object literal, `call` itself. That would silently shadow
 * `DrovrClient.prototype.call` with the fixture's raw, un-choke-pointed
 * `call`, and it stayed invisible for as long as pass-through and "call the
 * raw fixture directly" were indistinguishable — exactly until a real
 * correction registry made them diverge (caught by
 * `test/corrections.test.ts`'s both-routes test).
 */
export function buildFakeHerdrClient(
  options: {
    resultFor?: (call: RecordedCall) => unknown;
    errorFor?: (call: RecordedCall) => unknown;
  } = {},
): FakeHerdrClient {
  const real = new HerdrClient({ socketPath: "/dev/null/drovr-test-unused.sock" });
  const calls: RecordedCall[] = [];

  const respond = (call: RecordedCall): unknown => {
    calls.push(call);
    if (options.errorFor) {
      const err = options.errorFor(call);
      if (err !== undefined) throw err;
    }
    return options.resultFor ? options.resultFor(call) : { service: call.service, method: call.method };
  };

  const clientProto = {
    call(method: string, params: unknown) {
      return Promise.resolve().then(() => respond({ service: "client", method, args: [params] }));
    },
    subscribe(subscriptions: unknown) {
      return Promise.resolve().then(() => respond({ service: "client", method: "subscribe", args: [subscriptions] }));
    },
  };
  const client: Record<string, unknown> = Object.create(clientProto);
  client.opts = real.opts;
  for (const [key, value] of Object.entries(real)) {
    if (value === null || typeof value !== "object") continue;
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) continue;
    const fakeService = Object.create(proto, {
      call: {
        value: (method: string, params: unknown) =>
          Promise.resolve().then(() => respond({ service: key, method, args: [params] })),
      },
    });
    client[key] = fakeService;
  }

  return { client: client as unknown as HerdrClient, calls };
}
