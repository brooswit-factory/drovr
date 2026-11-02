// Recovered test-only utility: canonical temporary root for synthetic fixtures.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
export function realTmpdir(): string { return realpathSync(tmpdir()); }
