import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * `os.tmpdir()` with symlinks resolved. On macOS it is `/var/folders/...` and
 * `/var` is a symlink to `/private/var`, so code that refuses symlinked paths
 * (the AGY home, the native transcript reader) would reject every temp dir.
 */
export function realTmpdir(): string {
  return realpathSync(tmpdir());
}
