import type { Method, ParamsOf, ResultOf } from "@brooswit/herdr-sdk";
import type { ChokePoint } from "./choke-point.js";
import type { DrovrClient } from "./drovr-client.js";
/**
 * What a correction sees and can use. `client` is the RAW hatch (see
 * `DrovrClient.raw` in `drovr-client.ts`), never the corrected client --
 * that's what keeps a correction that calls back into herdr from ever
 * re-entering its own (or any) corrector. `method`/`params` are the WIRE
 * method and its wire-shaped params (see `service-proxy.ts`), which is what
 * makes `ResultOf<M>`/`ParamsOf<M>` type-check honestly here.
 */
export interface CorrectionContext<M extends Method> {
    readonly method: M;
    readonly params: ParamsOf<M>;
    readonly client: DrovrClient;
}
export type Correction<M extends Method> = (result: ResultOf<M>, ctx: CorrectionContext<M>) => ResultOf<M> | Promise<ResultOf<M>>;
/**
 * One entry per wire method that needs correcting.
 */
export type CorrectionRegistry = {
    [M in Method]?: Correction<M>;
};
/**
 * Default report corrections. A custom registry replaces these entries.
 */
export declare const defaultCorrections: CorrectionRegistry;
/**
 * Builds the choke point that applies a correction registry, keyed on the
 * wire method `wrapService`/`DrovrClient.call()` both resolve calls to.
 *
 * Identity is the default, preserved *structurally*, not by an `if` that
 * could be gotten wrong: when there's no registered correction, this
 * returns `invoke()` directly, exactly like `passThroughChokePoint` --  not
 * wrapped in an `async` function -- so the settled promise, its resolved
 * value, and any thrown error all come back by reference, unchanged. Only
 * the registered-correction path (necessarily) awaits and re-wraps.
 */
export declare function createCorrectionChokePoint(registry: CorrectionRegistry, getRawClient: () => DrovrClient): ChokePoint;
