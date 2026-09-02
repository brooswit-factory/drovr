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
 * `chokePoint`. Intercepts at the `Proxy` `get` trap and reflects over
 * whatever function it finds there — no method name list, so a method the
 * SDK adds tomorrow is covered automatically instead of silently missing.
 */
export function wrapService<T extends object>(serviceName: string, target: T, chokePoint: ChokePoint): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        chokePoint({ service: serviceName, method: String(prop), args }, () => Reflect.apply(value, t, args));
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
