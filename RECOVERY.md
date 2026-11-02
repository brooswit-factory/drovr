This branch preserves the maintained SDK source used by the recovered Butchr build. It is a draft recovery integration, not a release or runtime change.

The 342-input recovery snapshot was verified against its frozen census. The SDK's 150 bundled source modules and the legacy event package's 152 modules match the preserved source-map contents exactly. The SDK regression run passed 112 tests. Private Git history, runtime settings, conversations, credentials and operational receipts are excluded.

With Bun 1.3.11 and Node 20.20.2:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun test test/claude-ack-cursor.test.ts test/conversation-session.test.ts test/managed-herdr-lifecycle.test.ts test/native-transcript.test.ts test/owned-target-continuation.test.ts
cd legacy-events
bun install --frozen-lockfile --ignore-scripts
bun run build
```

`legacy-events` is the separately named older event package required by the recovered application. Its source was recovered from the preserved source maps. Its Herdr dependency is pinned to public version 0.1.3; that published module matches the original embedded module hash. No opaque original package archive is included.

The source payload overlays the existing public main branch; material outside the payload retains that public baseline. Review compatibility with newer main changes before merging. Source recovery and the requested rule bug fix remain separate changes.
