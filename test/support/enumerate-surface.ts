import type { HerdrClient } from "@brooswit/herdr-sdk";

/**
 * Learns HerdrClient's method surface at runtime from a real (never-
 * connected) instance -- no hard-coded name list. This is the same
 * discovery technique `src/service-proxy.ts` uses to wrap services, so
 * any test built on this genuinely fails if that technique, or
 * DrovrClient's use of it, stops reaching a method: it isn't asserting
 * against a name list that could itself silently miss the same drift.
 *
 * Shared by `test/parity.test.ts` and `test/choke-point-seam.test.ts` so
 * there is exactly one definition of "the enumerated surface" — two
 * divergent copies could go stale against each other.
 */
export function enumerateSurface(client: HerdrClient): Array<{ service: string; method: string }> {
  const surface: Array<{ service: string; method: string }> = [];
  for (const [key, value] of Object.entries(client)) {
    if (value === null || typeof value !== "object") continue;
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) continue;
    for (const method of Object.getOwnPropertyNames(proto)) {
      if (method === "constructor") continue;
      surface.push({ service: key, method });
    }
  }
  return surface;
}
