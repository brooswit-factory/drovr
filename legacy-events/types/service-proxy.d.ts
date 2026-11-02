import type { ChokePoint } from "./choke-point.js";
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
export declare function wrapService<T extends object>(serviceName: string, target: T, chokePoint: ChokePoint): T;
/**
 * Wraps every service field on a herdr-client-shaped object. Fields are
 * discovered by reflecting over `inner`'s own enumerable properties, so a
 * service the SDK adds tomorrow is covered automatically too — no service
 * name is ever named here. Non-service fields (`opts`) pass through as-is.
 */
export declare function wrapServices<T extends object>(inner: T, chokePoint: ChokePoint): Record<string, unknown>;
