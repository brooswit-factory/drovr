import { describe, expect, test } from "bun:test";
import { checkCanonicalMode } from "../src/terminal-readiness.js";

describe("checkCanonicalMode (FACTORY-1037)", () => {
  // Deliberately exercises only the paths that are safe and deterministic
  // without a real pty: a nonexistent pid must degrade to "unavailable",
  // never throw and never report "canonical" or "raw" without real
  // evidence. The actual canonical/raw distinction against a real shell's
  // pty is exercised live (see that ticket's PR description for the
  // reproduction); it is not re-asserted here to avoid a flaky, platform-
  // and timing-dependent unit test.
  test("a pid with no such process resolves to unavailable, never throws", async () => {
    await expect(checkCanonicalMode(999_999_999)).resolves.toBe("unavailable");
  });

  test("pid 0 (invalid) resolves to unavailable", async () => {
    await expect(checkCanonicalMode(0)).resolves.toBe("unavailable");
  });
});
