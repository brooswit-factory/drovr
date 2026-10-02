# permission-blank-row fixtures (FACTORY-603/604/605)

Real captures of Claude Code "Bash command" approval dialogs from live managed-session panes
(2026-09-29 to 2026-10-01, drovr 0.16.8). Each was captured while the dialog sat unanswered.
Option 2's long label wraps and leaves a blank row between its continuation and option 3.

- `pane-factory603-NN-blank-row.txt`: the screen as captured (blank row inside the option block).
- `pane-factory603-NN-unwrapped-twin.txt`: the same screen with the whitespace-only rows between the first and last numbered option line removed (what the dialog looks like without the blank row).

| NN | option 2 label | notes |
|---|---|---|
| 01, 04, 07, 08 | `Yes, allow reading from <dir> from this project` | read-only reads outside the project; 08 is a re-capture of 07 |
| 02, 03 | `Yes, and don’t ask again for: <command>` | carries Claude Code's "manual approval required to prevent path resolution bypass" warning; 03 is a re-capture of 02 |
| 05, 06 | `Yes, and don’t ask again for: <command>` | the command contains `rm -f`; 06 is a re-capture of 05 |

The apostrophe in "don’t" is U+2019, not ASCII.

## Scrubbing (public repo)
Only the pane text is kept (no capture header). Every substitution is length-preserving, so every row keeps its exact length, wrapping and blank-row position:
user, machine and project names, home paths, the uid in `/tmp/claude-<uid>`, build hashes, role and channel names and every UUID piece are replaced by same-length placeholders (runs of `x`); the agent's own free text (narration and chat-preview rows above the first full-width separator, task-output paths, and the one-line tool summary inside the dialog frame) is masked letter-for-letter (`x`) and digit-for-digit (`0`). Structural UI text (separators, option labels, "Do you want to proceed?", footer, the "manual approval required" warning) is verbatim. Verified: the unwrapped twins classify field-for-field like the unscrubbed originals, and the blank-row screens are unrecognised before the fix in both forms.
