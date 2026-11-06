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

export type CanonicalModeState = "canonical" | "raw" | "unavailable";

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
 * Returns "unavailable" for anything this cannot determine (no /proc entry,
 * permission denied, stty missing, a non-Linux host, a malformed readlink
 * target). Callers MUST treat "unavailable" as "cannot verify, not as
 * uncanonical" -- see the doc comment on its one caller for why that
 * degrades to the pre-existing (unprotected) behavior rather than refusing.
 */
export async function checkCanonicalMode(shellPid: number): Promise<CanonicalModeState> {
  let ttyPath: string;
  try {
    ttyPath = await readlink(`/proc/${shellPid}/fd/0`);
  } catch {
    return "unavailable";
  }
  if (!ttyPath.startsWith("/dev/")) return "unavailable";
  return new Promise((resolve) => {
    execFile("stty", ["-F", ttyPath, "-g"], { timeout: 1_000 }, (error, stdout) => {
      if (error) { resolve("unavailable"); return; }
      // Machine format: iflag:oflag:cflag:lflag:line:cc[0]:cc[1]:... , all hex.
      const lflagHex = stdout.trim().split(":")[3];
      const lflag = lflagHex === undefined ? NaN : Number.parseInt(lflagHex, 16);
      resolve(Number.isFinite(lflag) ? ((lflag & ICANON) !== 0 ? "canonical" : "raw") : "unavailable");
    });
  });
}
