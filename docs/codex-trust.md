# Codex directory trust correction

The reported Herdr 0.8.2 `agent.start` result was `idle` with
`interactive_ready: true` while Codex displayed its directory trust dialog.
This is timing/detection dependent, not a claim that Herdr misses every trust
prompt. Drovr now corrects idle and done reports using the public SDK. Done
can represent the same underlying idle state for unseen background work.

## Behavior and coverage

- Default corrections cover `agent.list`, `agent.get`, `agent.start`,
  `agent.prompt`, and successful `agent.wait`, through services and `call()`.
- Only records with `agent === "codex"` and status `idle` or `done`
  trigger an extra raw `pane.read` (`visible`, `text`, `strip_ansi: true`).
- The complete visible screen must match the directory heading, exact English
  warning, both choices, a selection marker, and final enter instruction.
  Whitespace wrapping is tolerated. Prefixed narration, blockquotes, fenced
  text, old prompts followed by newer output, and incomplete dialogs fail.
- A match copies only the affected record and enclosing result, setting
  `agent_status: "blocked"` and `interactive_ready: false`. Other fields and
  unaffected list records remain unchanged. A no-match returns the original
  result object. Registered methods await the read, so promise identity and
  latency are not preserved.
- Failed, truncated, wrong-pane, or wrong-source reads are unknown evidence:
  return the original report, without inventing `blocked` or an SDK status.
  Original RPC errors, including timeout and agent_not_ready, propagate intact.
- No keys, autoapproval, configuration changes, retries, or cached detections.
  Raw reads use the same client/socket and cannot re-enter corrections.

This is conservative screen recognition, not proof of terminal interactivity.
An exact full-screen replay of the dialog is indistinguishable from the actual
dialog with the public text-read API. Different wording, localization, banners,
partial screens, other statuses, or a pane changing between calls can escape
detection. One raw read is added per eligible agent per report, using the
client's existing RPC timeout; list reads run concurrently.

`wait` still uses Herdr's server-side condition and timeout. A successful
`wait(until: ["idle"])` can return corrected `blocked`; a waiting server cannot
be interrupted by this result hook. Start/prompt actions precede correction.
Event subscriptions, session snapshots, pane reports, and `.raw` are untouched.
Consumers must use corrected agent reports and check `agent_status` before
dispatch/completion; event-only consumers need an `agent.get/list` refresh.

## Validation on 2026-09-12

Started from canonical `56a38a0`. Tests use the exact visible text captured
read-only from a dedicated, isolated Herdr test session's trust-dialog probe.
At inspection, the parked probe was already raw `blocked`; Drovr correctly
left it blocked. Parent reports this launch returned `agent_not_ready`, unlike
the earlier idle result. Controls `codex-smoke` and `codex-first-run` were
raw idle and done. The captured dialog combined with the earlier idle report
is regression coverage, not a newly observed live idle misclassification.
A built-package check also supplied a synthetic idle record to the correction
while reading the real parked pane: it returned blocked/interactive_ready false.
Live raw and corrected lists both retained idle/done/blocked for the three agents.

The suite exercises all five methods through both routes, no-match identity,
Claude and other states, quoted/stale text, selection, unknown reads, raw
bypass, custom registry opt-out, mixed lists, and original timeout identity.

The operator recorded the verification milestone on the Drovr and Butchr
Confluence roots. No Jira changes were made.

## Release and consumer handoff

`npm view @brooswit/drovr version dist-tags --json` returned public-registry
E404 on 2026-09-12. This checkout prepares version `0.1.0`; a public release is
not currently available. No commit or publication is part of this change.
GitHub reports `brooswit-factory/drovr` PUBLIC, so a versioned GitHub release
asset is an available delivery route without npm credential bootstrap. Parent
reports npm whoami E401 and no repository secrets; no token was requested.

The minimal package path uses the existing Bun bundle and TypeScript
declarations. `prepack` runs all checks and rebuilds; `files` includes `dist`
and documentation, and `publishConfig.access` is public. After parent review:

1. Review the prepared first release version `0.1.0`.
2. Run `bun run check` and `npm pack --dry-run`; review the package contents.
3. With explicit publish authorization and npm scope access, run
   `npm publish --access public`, then verify `npm view @brooswit/drovr version`.
4. In the parent-owned Butchr checkout, run
   `bun add @brooswit/drovr@0.1.0` (or the actual chosen version), replace the
   runtime `HerdrClient` import/constructor with `DrovrClient`, and update the
   lockfile. Preserve the existing explicit socket/options. SDK types/errors
   can be imported from Drovr. Do not select `.raw`, an empty registry, or a
   custom choke point for normal lifecycle/status reads.
5. Run Butchr checks and validate status polling and lifecycle blocked handling
   against the isolated session. Check returned status even after successful
   start/prompt/wait. The scoped trust launch override is separate from this
   reporting correction and does not substitute for consuming Drovr.

The public-access command follows
[npm's scoped package publishing documentation](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).

### GitHub release asset route

The prepared artifact is `artifacts/brooswit-drovr-0.1.0.tgz`. Rebuild with
`npm pack --pack-destination artifacts`; prepack runs the checks. Parent should
commit/merge the reviewed source and tag that exact commit `v0.1.0`, then run:

```sh
gh release create v0.1.0 artifacts/brooswit-drovr-0.1.0.tgz --verify-tag --title 'Drovr 0.1.0' --notes 'Correct idle Codex directory trust reports using visible pane evidence.'
```

This command is a publishing step for the parent, not executed here. The
resulting URL is expected to be:
`https://github.com/brooswit-factory/drovr/releases/download/v0.1.0/brooswit-drovr-0.1.0.tgz`.
It does not exist until the parent creates the release. In Butchr, install:

```sh
bun add '@brooswit/drovr@https://github.com/brooswit-factory/drovr/releases/download/v0.1.0/brooswit-drovr-0.1.0.tgz'
```

Commit Butchr's dependency and Bun lockfile, verify the downloaded integrity
against the reviewed tarball, and make the same DrovrClient import/constructor
and status checks above. Do not replace assets behind an existing version URL.
This delivers a reusable public package without a local path dependency.
