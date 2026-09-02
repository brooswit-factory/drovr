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
 * never touches a socket. Every service field becomes an object with the
 * real service's prototype (so it's recognized as a "service" the exact
 * same way `src/service-proxy.ts` recognizes a real one) but with every
 * method replaced, as an own property, by a stub that records the call
 * and resolves to a per-call result — or rejects with a per-call error,
 * as the exact thrown value/instance.
 *
 * Discovered entirely by reflection: no service or method name is written
 * here, on purpose, mirroring the drift-proofing the ticket requires of
 * `src/` itself, so this fixture doesn't quietly go stale either.
 *
 * `calls` is returned alongside `client`, not attached to it — attaching
 * test bookkeeping directly onto the object passed as `herdr:` would make
 * it just another own property for `wrapServices` to discover and treat
 * as a pass-through field, which isn't what a real `HerdrClient` ever has.
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

  const client: Record<string, unknown> = { opts: real.opts };
  for (const [key, value] of Object.entries(real)) {
    if (value === null || typeof value !== "object") continue;
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) continue;
    const fakeService: Record<string, unknown> = Object.create(proto);
    for (const method of Object.getOwnPropertyNames(proto)) {
      if (method === "constructor") continue;
      fakeService[method] = (...args: unknown[]) =>
        Promise.resolve().then(() => respond({ service: key, method, args }));
    }
    client[key] = fakeService;
  }
  client.call = (method: string, params: unknown) =>
    Promise.resolve().then(() => respond({ service: "client", method, args: [params] }));
  client.subscribe = (subscriptions: unknown) =>
    Promise.resolve().then(() => respond({ service: "client", method: "subscribe", args: [subscriptions] }));

  return { client: client as unknown as HerdrClient, calls };
}
