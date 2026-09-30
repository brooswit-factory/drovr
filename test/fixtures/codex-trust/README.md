# codex-trust fixtures

`pane-win32-reconstructed.txt` is **reconstructed, not a real capture**. No
Windows/ConPTY session was available to record Codex's own directory-trust
dialog for FACTORY-561 (flagged on the ticket). It takes the real Linux
capture already used in `test/codex-trust.test.ts` and applies the two
Windows differences that are actually known:

- CRLF line endings (ConPTY convention).
- A Windows drive-letter cwd (`C:\Users\...`) in the "You are in" heading,
  in place of the POSIX path Codex prints on Linux.

Everything else — wording, the `\u203a` cursor marker, the numbered options,
the footer — is assumed unchanged. That assumption, and whether Codex prints
a drive path, a forward-slash path, or a UNC path in this heading on native
Windows, needs verifying against a real capture on zippy.
