import { describe, expect, test } from "bun:test";
import { checkCanonicalMode } from "../src/terminal-readiness.js";

describe("checkCanonicalMode (FACTORY-1037)", () => {
  // Deliberately exercises only the paths that are safe and deterministic
  // without a real pty: a nonexistent pid on this (Linux) test host is a
  // TRANSIENT read failure ("unknown"), never "canonical" or "raw" without
  // real evidence, and never the STATIC "unsupported" (this test runs on
  // Linux; that path is exercised via the injected test seam in
  // agent-start.test.ts, which does not depend on the real platform).
  // The actual canonical/raw distinction against a real shell's pty is
  // exercised live (see that ticket's PR description for the
  // reproduction); it is not re-asserted here to avoid a flaky, platform-
  // and timing-dependent unit test.
  test("a pid with no such process resolves to unknown (transient), never throws", async () => {
    await expect(checkCanonicalMode(999_999_999)).resolves.toBe("unknown");
  });

  test("pid 0 (invalid) resolves to unknown", async () => {
    await expect(checkCanonicalMode(0)).resolves.toBe("unknown");
  });
});
