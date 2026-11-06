import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";

// Linux lflag bit (asm-generic/termbits.h), NOT the same numeric value as
// some other platforms' termios -- verified against this host's own
// `python3 -c "import termios; print(hex(termios.ICANON))"` (0x2) and
// cross-checked live against `stty -a`'s own "icanon"/"-icanon" text on a
// real pane while investigating this ticket, after an earlier draft of
// this file used the wrong value (0x100) and silently reported every
// genuinely-canonical pane as "raw".
const ICANON = 0x2;

/**
 * "unsupported" is a STATIC, permanent fact about this host (not Linux --
 * ConPTY has no canonical-mode concept this check could apply to anyway)
 * -- retrying it can never produce a different answer, so the one caller
 * treats it as a one-shot, proceed-immediately signal with no polling.
 *
 * "unknown" is a TRANSIENT failure on an otherwise-supported host (a
 * readlink or stty call that failed or timed out just now) -- unlike
 * "unsupported", a LATER attempt commonly does succeed (the exact failure
 * mode a newly-created pane's shell_pid not being populated YET produces),
 * so the one caller treats it the same as "canonical": not yet confirmed
 * safe, keep polling within the bound, and refuse once that bound passes.
 *
 * Collapsing these two into one "cannot verify" value was FACTORY-1037's
 * own review finding: it let a transient, soon-to-resolve gap in the
 * EXACT newly-created-pane window this ticket targets fall through to
 * "proceed immediately", defeating the gate for precisely the case it
 * exists to cover.
 */
export type CanonicalModeState = "canonical" | "raw" | "unsupported" | "unknown";

const PLATFORM_SUPPORTED = process.platform === "linux";

/**
 * Ground-truth check for whether a pane's shell has actually left kernel
 * canonical ("cooked") TTY mode -- the mode in which a single injected line
 * longer than MAX_CANON (4096 bytes on Linux) is silently capped at that
 * boundary with no error and no terminating newline delivered, so the
 * command never submits (FACTORY-1037; reproduced in isolation with a bare
 * `pty.openpty()` pair, and live against this deployed herdr with a
 * deliberately slow shell startup -- see that ticket's evidence).
 *
 * herdr's own pre-launch busy check is foreground-process-based (is there a
 * child process besides the shell?) and cannot see this: a pane can report
 * "no foreground child, just the shell" for a brief window before the shell
 * has actually called tcsetattr to leave canonical mode. This resolves the
 * pane's already-reported shell_pid to its controlling tty via
 * /proc/<pid>/fd/0 (same host, same user -- the deployed stack is
 * single-host) and reads its REAL termios state with `stty -g`, machine
 * format (locale-independent, unlike `-a`), rather than trusting herdr's
 * self-report.
 *
 * See CanonicalModeState's own doc comment for the "unsupported" vs
 * "unknown" distinction and why it matters -- callers must never treat
 * either as proof the shell left canonical mode.
 */
export async function checkCanonicalMode(shellPid: number): Promise<CanonicalModeState> {
  if (!PLATFORM_SUPPORTED) return "unsupported";
  let ttyPath: string;
  try {
    ttyPath = await readlink(`/proc/${shellPid}/fd/0`);
  } catch {
    return "unknown";
  }
  if (!ttyPath.startsWith("/dev/")) return "unknown";
  return new Promise((resolve) => {
    execFile("stty", ["-F", ttyPath, "-g"], { timeout: 1_000 }, (error, stdout) => {
      if (error) { resolve("unknown"); return; }
      // Machine format: iflag:oflag:cflag:lflag:line:cc[0]:cc[1]:... , all hex.
      const lflagHex = stdout.trim().split(":")[3];
      const lflag = lflagHex === undefined ? NaN : Number.parseInt(lflagHex, 16);
      resolve(Number.isFinite(lflag) ? ((lflag & ICANON) !== 0 ? "canonical" : "raw") : "unknown");
    });
  });
}
