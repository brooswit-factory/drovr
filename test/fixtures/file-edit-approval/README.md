# file-edit-approval fixtures

All `pane-*.txt` files here are REAL captures: a live `claude` 2.1.251 pane,
launched in `--permission-mode default`, driven through `herdr agent prompt`
to edit or create a file, then read with `herdr pane read --source visible`.
No screen in this directory was invented from the ticket's prose or from
FACTORY-460's diagnosis-comment probes.

- `pane-notes-md-edit-header-visible.txt` — editing a file already inside the
  session's trusted root (the pane's own cwd). Option 2 reads "Yes, and
  switch to accept edits (auto-approve file edits and common file commands)
  for this session (shift+tab)" — **no directory anywhere in the dialog.**
  This is the capture that falsifies FACTORY-460's "25 of 25 edit/create
  captures had the directory in option 2" claim as a universal rule: it does
  not hold when the edited file is already inside the trusted root. See
  `docs/permission-approval.md` for how `classifyPermissionPrompt` handles
  this (the `path` field stays `undefined` on this shape).
- `pane-outside-dir-edit-header-visible.txt` — editing a file outside the
  trusted root (`/tmp/claude-1002/outside-dir/OUTSIDE.md` from a pane whose
  cwd is elsewhere). Here option 2 IS compound and DOES carry a directory:
  "Yes, and switch to accept edits (auto-approve file edits and common file
  commands) for this session; Yes, and always allow access to
  `/tmp/claude-1002/outside-dir` for this session (shift+tab)" — one option,
  wrapped onto three physical lines, granting both the accept-edits toggle
  and the directory access in a single affirmative choice. This is the
  capture GUARD 1's path derivation is built against.

Both `pane-*.txt` captures have their header (the `─{10,}` separator, the
"Edit file" title, and the path/basename subtitle line) fully visible, so
both already classify via the EXISTING general `SEPARATOR` arm in
`classifyPermissionPrompt` — they establish the baseline shape before any
truncation.

The `synthetic-*.txt` files are each a REAL capture above, truncated (never
invented) to simulate the header having scrolled off the top of a pane
shorter than the dialog:

- `synthetic-notes-md-edit-scrolled-off-3-rows.txt` — `pane-notes-md-edit-header-visible.txt`
  with its top 3 dialog rows cut (the separator, "Edit file", and the
  "NOTES.md" subtitle). The diff's own opening `╌` border is the first line
  left on screen. This is the primary CLASS 1 fixture (FACTORY-460): no rule,
  no title line, and no directory in option 2.
- `synthetic-notes-md-edit-scrolled-off-mid-diff.txt` — the same capture cut
  deeper (6 rows): the diff's opening border and its first two numbered lines
  are also gone, leaving only the diff's tail, its closing border, the
  question, the options, and the footer. FACTORY-583: the opening border is
  the only anchor for where the diff body starts, so once it's also gone
  there is nothing left to bound `request` by — recognition REFUSES
  (`undefined`) on this shape rather than guess a body out of whatever
  scrollback sits above the closing border, which previously made `promptId`
  drift with scrollback (see `docs/permission-approval.md` and GUARD 5 in
  `src/permission-approval.ts`). This fixture is kept as the negative proof
  of that refusal, not as a recognised capture.
- `synthetic-outside-dir-edit-scrolled-off-3-rows.txt` — `pane-outside-dir-edit-header-visible.txt`
  with the same top-3-rows cut. Exercises the `path` derivation (GUARD 1)
  with the header gone AND the directory-bearing compound option 2 present.
- `synthetic-notes-md-edit-torn-option-scrolled-off.txt` — the header-scrolled-off
  NOTES.md capture with option 3's label hand-mutated from `No` to `Nossion`
  (matching FACTORY-460's class 3 torn-label report) and otherwise untouched.
  This is a NEGATIVE fixture: per the fixture-first rule, a negative test (a
  shape that must STAY unrecognised) does not need a real tear to be
  legitimate, since refusing more is always safe. Used to pin that the new
  file-edit sibling does not accidentally start answering a torn capture.

Class 2 from FACTORY-460 (a blank line inside the option block) has no real
capture on this host and is NOT fixed here — see the PR description.
