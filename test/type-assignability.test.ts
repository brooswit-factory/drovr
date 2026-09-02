import { describe, expect, test } from "bun:test";
import type { HerdrClient } from "@brooswit/herdr-sdk";
import { DrovrClient } from "../src/drovr-client.js";

// Type-level check, not a runtime one: if DrovrClient's shape ever drifts
// from HerdrClient's -- a field removed or retyped, or a new service
// added to HerdrClient and not mirrored on DrovrClient -- this line fails
// `tsc -p tsconfig.json --noEmit`. This file lives under `test/`, which
// tsconfig.json's `include` covers, so `bun run typecheck` actually
// reaches it (not just `bun test`, which doesn't type-check at all).
const structurallyAssignable: HerdrClient = new DrovrClient();

describe("DrovrClient / HerdrClient structural assignability", () => {
  test("a DrovrClient can stand in anywhere a HerdrClient is expected (enforced by the const above at typecheck time)", () => {
    expect(structurallyAssignable).toBeInstanceOf(DrovrClient);
  });
});
