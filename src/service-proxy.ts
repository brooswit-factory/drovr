import type { ChokePoint } from "./choke-point.js";

/**
 * A value counts as a "service" (something to proxy method calls on)
 * exactly when it's an object whose prototype is something other than
 * plain `Object.prototype` — i.e. an instance of a real class, the way
 * every herdr SDK service (AgentService, PaneService, ...) is. Plain data
 * objects (like `HerdrClientOptions`/`RpcOptions`) fail this check and are
 * passed through untouched. This is how service discovery stays dynamic:
 * no service name is ever named in this file.
 */
function isServiceLike(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto !== null && proto !== Object.prototype;
}

/**
 * Wraps one service instance so every method call on it funnels through
 * `chokePoint` keyed on the WIRE method (e.g. `"agent.send_keys"`), not the
 * JS method name (e.g. `"sendKeys"`) — the two differ for several methods
 * (`setView` -> `agent.view.set`, `sendKeys` -> `agent.send_keys`, ...) and
 * no convention maps one to the other (see `docs/correction-seam.md`).
 *
 * Every real service method is a one-line delegation onto the base `Service`
 * class: `return this.call(wireMethod, params)`. So instead of intercepting
 * the JS-level call directly, this invokes the real method with a `this`
 * whose OWN `call` is trapped — the method's body still runs for real, but
 * when it reaches `this.call(wireMethod, params)`, that resolves to our
 * trap instead of `Service.prototype.call`, handing us the exact wire
 * method and params with no name table and no drift. `Service.prototype.call`
 * is the last point drovr can reach before herdr's own `rpc()`, and it's
 * where both the service-method route and the `client.call()` route
 * converge on the same wire identity.
 *
 * If a method's body never reaches `this.call` (no trappable `call` on the
 * target at all, or the method just doesn't use it), `chokePoint` is never
 * invoked for that call — the real method's own result is returned as-is.
 * That is the deliberate, safe fallback: no wire name means no correction,
 * never a guessed key.
 */
export function wrapService<T extends object>(serviceName: string, target: T, chokePoint: ChokePoint): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      const realCall = (t as { call?: unknown }).call;
      if (typeof realCall !== "function") {
        // No trappable wire-level seam on this target -- run the real
        // method untouched rather than guess a key for the choke point.
        return (...args: unknown[]) => Reflect.apply(value, t, args);
      }
      return (...args: unknown[]) => {
        const trappedThis = Object.create(t, {
          call: {
            value: (wireMethod: string, params: unknown) =>
              chokePoint({ service: serviceName, method: wireMethod, args: [params] }, () =>
                Reflect.apply(realCall, t, [wireMethod, params]),
              ),
          },
        });
        return Reflect.apply(value, trappedThis, args);
      };
    },
  }) as T;
}

/**
 * Wraps every service field on a herdr-client-shaped object. Fields are
 * discovered by reflecting over `inner`'s own enumerable properties, so a
 * service the SDK adds tomorrow is covered automatically too — no service
 * name is ever named here. Non-service fields (`opts`) pass through as-is.
 */
export function wrapServices<T extends object>(inner: T, chokePoint: ChokePoint): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inner)) {
    wrapped[key] = isServiceLike(value) ? wrapService(key, value, chokePoint) : value;
  }
  return wrapped;
}
