import { HerdrClient, type HerdrClientOptions } from "@brooswit/herdr-sdk";
import type { Method, ParamsOf, ResultOf } from "@brooswit/herdr-sdk";
import { passThroughChokePoint, type ChokePoint } from "./choke-point.js";
import { wrapServices } from "./service-proxy.js";
import { createCorrectionChokePoint, defaultCorrections, type CorrectionRegistry } from "./corrections.js";

export interface DrovrClientOptions extends HerdrClientOptions {
  /** Test seam: inject a fake/mock inner client instead of constructing a real `HerdrClient`. */
  herdr?: HerdrClient;
  /** Test seam: override the choke point every call routes through. Defaults to the correction registry below. */
  chokePoint?: ChokePoint;
  /** Test seam: override the correction registry the default choke point applies. Defaults to the empty, shipped registry. */
  corrections?: CorrectionRegistry;
}

/**
 * Drop-in pass-through for `HerdrClient`. Every service method call and
 * every `call()` funnels through a single choke point (see
 * `choke-point.ts`) that today does nothing but forward to a real inner
 * `HerdrClient` and return its result, or rethrow its error, unchanged.
 *
 * The 12 service fields below are wrapped dynamically at construction time
 * (see `service-proxy.ts`) — nothing in this file forwards an individual
 * method by name, so a method (or a whole service) the SDK adds tomorrow
 * is covered without a code change here. The field *declarations* below
 * exist only so `DrovrClient` is structurally assignable to `HerdrClient`
 * at compile time (see the type-assignability test); each type is derived
 * from `HerdrClient` itself via indexed access, never duplicated.
 */
export class DrovrClient {
  readonly opts!: HerdrClient["opts"];
  readonly server!: HerdrClient["server"];
  readonly session!: HerdrClient["session"];
  readonly agent!: HerdrClient["agent"];
  readonly pane!: HerdrClient["pane"];
  readonly workspace!: HerdrClient["workspace"];
  readonly tab!: HerdrClient["tab"];
  readonly worktree!: HerdrClient["worktree"];
  readonly layout!: HerdrClient["layout"];
  readonly plugin!: HerdrClient["plugin"];
  readonly integration!: HerdrClient["integration"];
  readonly ui!: HerdrClient["ui"];
  readonly events!: HerdrClient["events"];

  /**
   * The raw, uncorrected escape hatch (§4 property 4 of DROVR-6): a
   * `DrovrClient` sharing this instance's inner herdr client, but wired to
   * `passThroughChokePoint` so it never consults the correction registry.
   * This is what `ctx.client` (see `corrections.ts`) hands a correction, so
   * a correction calling back through it can never re-enter any corrector
   * -- bounding recursion structurally instead of by a depth counter. It's
   * also how a consumer tells "is herdr still wrong about this?" apart from
   * drovr's own correction.
   */
  readonly raw: DrovrClient;

  private readonly inner: HerdrClient;
  private readonly chokePoint: ChokePoint;

  constructor(options: DrovrClientOptions = {}) {
    const { herdr, chokePoint, corrections, ...herdrOptions } = options;
    this.inner = herdr ?? new HerdrClient(herdrOptions);

    if (chokePoint === passThroughChokePoint) {
      // Base case: this construction *is* the raw client (see the `raw`
      // branch below) -- terminate the recursion here instead of building
      // yet another raw client underneath it.
      this.chokePoint = passThroughChokePoint;
      this.raw = this;
    } else {
      this.raw = new DrovrClient({ herdr: this.inner, chokePoint: passThroughChokePoint });
      this.chokePoint = chokePoint ?? createCorrectionChokePoint(corrections ?? defaultCorrections, () => this.raw);
    }

    Object.assign(this, wrapServices(this.inner, this.chokePoint));
  }

  /** Escape hatch, mirroring `HerdrClient.call` exactly — routed through the choke point. */
  call<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    return this.chokePoint({ service: "client", method, args: [params] }, () =>
      this.inner.call(method, params),
    ) as Promise<ResultOf<M>>;
  }

  /**
   * `subscribe()` does not go through the choke point: it opens its own
   * long-lived socket connection directly, never going through `rpc()`
   * the way every service method and `call()` do, so there is no discrete
   * per-call result/error to intercept here. Passed straight through to
   * the inner client, same `Subscription` instance returned.
   */
  subscribe(...args: Parameters<HerdrClient["subscribe"]>): ReturnType<HerdrClient["subscribe"]> {
    return this.inner.subscribe(...args);
  }
}
