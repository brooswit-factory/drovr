Merged PR [#97](https://github.com/brooswit-factory/drovr/pull/97) preserves the maintained SDK source used by the recovered Butchr build. Source integration is complete; this does not establish a release or installation on any host.

The 342-input recovery snapshot was verified against its frozen census. The SDK's 150 bundled source modules and the legacy event package's 152 modules match the preserved source-map contents exactly. The SDK regression run passed 112 tests. Private Git history, runtime settings, conversations, credentials and operational receipts are excluded.

The complete application build requires two sibling repositories. With Bun 1.3.11 and Node 20.20.2, start in an empty parent directory and use the same immutable pins as [Butchr's setup guide](https://github.com/brooswit-factory/butchr/blob/main/RECOVERY.md). No recovery branch is required.

```sh
git clone https://github.com/brooswit-factory/drovr.git drovr
git -C drovr checkout --detach 4df054e3767d2af6568346daae0d29e85ed11d61
git clone https://github.com/brooswit-factory/butchr.git butchr
git -C butchr checkout --detach 2962b6141096abb9553fc8bad6b5c63f18ddace3
(cd drovr && bun install --frozen-lockfile --ignore-scripts && bun run build)
(cd drovr/legacy-events && bun install --frozen-lockfile --ignore-scripts && bun run build)
cd butchr
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run typecheck:web
bun run build
```

The pinned SDK passed [CI](https://github.com/brooswit-factory/drovr/actions/runs/41382973751); the application source tree passed [all four CI jobs](https://github.com/brooswit-factory/butchr/actions/runs/41392065694). The merged source trees match those reviewed commits.

`legacy-events` is the separately named older event package required by the recovered application. Its source was recovered from the preserved source maps. Its Herdr dependency is pinned to public version 0.1.3; that published module matches the original embedded module hash. No opaque original package archive is included.

The source payload was integrated with the existing public main branch, including current-main listing coalescing, approval dependency forwarding and unwanted bypass-argument detection. Butchr PR #825 separately integrated the application and rule-OFF fix. Private recovery history and runtime data remain excluded.
