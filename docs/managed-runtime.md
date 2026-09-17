# Managed agent runtime

Drovr is the provider-management layer between an application and Herdr.
Herdr owns panes, workspaces, process transport, and base agent operations.
The application owns desired workspaces and product policy. Drovr owns the
differences between supported agent providers.

## Identity

A managed agent is identified by its workspace directory. A pane ID is an
optional cached live handle. Friendly names are display metadata and are never
used to recover or authorize an agent.

`resolveManagedAgent` first accepts a cached pane only when it still matches
the expected workspace and optional provider. Otherwise it searches by
workspace. Zero matches are missing; multiple matches are ambiguous. Prompt
and close operations act only on an unambiguous resolution.

## Launch and health

`buildAgentStartParams` translates a typed Claude, Codex, or AGY launch request into
Herdr's `agent.start` parameters. It does not select a provider or model and
does not fall back after failure.

MCP configuration and development channels are provider-neutral launch inputs.
`mcpConfigPath` and `developmentChannels` are accepted for every provider;
Drovr owns the translation. Claude receives `--mcp-config <path>` and, when at
least one channel is named, `--dangerously-load-development-channels` followed
by the requested channels; an empty list loads no channels and emits no flag.
Codex and AGY accept the same inputs and spell neither flag, so no caller has
to branch on Claude to configure a managed worker.

`ManagedHerdrStartRequest` carries the same two fields, so a caller can state
them once per request instead of inside a provider-specific `prepare` result.
The two combine differently, because their shapes differ: a request's
`mcpConfigPath` replaces the prepared one, since a launch reads exactly one
file, while `developmentChannels` merge. A request naming `server:yappr` adds
it to a launch that already configures `server:butchr` rather than dropping it;
duplicates collapse and first-mention order is kept. An empty request list adds
nothing and preserves what the launch configures. `mergeDevelopmentChannels`
applies the same rule for callers combining channel lists of their own.

`checkManagedAgentArgv` compares every configured channel against the live
process, not just the first, so a worker that lost one channel reads as drifted.

AGY launches inherit the pane's working directory and use external MCP
configuration, which can connect a stdio-to-HTTP bridge. Drovr supplies no cwd
or MCP CLI override. `AgyAgentLaunch.skipPermissions` defaults to false; only
explicit `true` adds AGY's `--dangerously-skip-permissions` flag. Permission
policy belongs to the caller. This option does not configure workspace trust.

AGY's new-workspace trust screen remains even with permission prompts skipped,
and parent-directory trust does not extend to children. After creating a
factory-owned workspace and immediately before launching an unattended worker,
the caller must await:

```ts
await prepareManagedAgentWorkspace({ provider, cwd, unattended: true });
```

For AGY, this helper validates the existing directory, resolves its realpath,
and adds only that exact path to `trustedWorkspaces` in
`~/.gemini/antigravity-cli/settings.json`. It refuses root, home, and ancestors
of home. Missing settings are created; other settings and existing trust entries
are preserved. Invalid JSON or an invalid settings schema rejects without an
overwrite, so callers must propagate preparation failures and skip launch.
Updates use a mode-0600 temporary file and atomic replacement, with cleanup on
failure. Concurrent helper calls are serialized within the process; this is not
a lock against independent external settings writers. Other providers and calls
without explicit `unattended: true` perform no filesystem work. Tests can pass an
isolated settings path as the second argument. Launch-argument construction
remains free of these side effects.

`managedAgentProviderOfProcess` recognizes supported provider processes from
their executable or reported process name. `checkManagedAgentArgv` validates
the persistent launch arguments that must survive restoration while ignoring
startup-only choices such as model and effort.

## Codex MCP inventory

`inventoryCodexMcpServers` performs the bounded read-only Codex CLI probe and
returns an explicit success or failure result. `parseCodexMcpInventory`
validates names and transport kinds and can exclude the caller's own MCP
server. Raw output and thrown provider errors are never included in the
failure result.

Consumers decide what inventory failure means. Butchr currently blocks new
Codex launches while continuing to manage already-running workers.

## Release handoff

The original managed-runtime APIs require Drovr 0.2.0; AGY `skipPermissions`
requires 0.3.1 and workspace preparation requires 0.3.2. See the
[changelog](changelog.md). The prepared immutable GitHub release asset is
`artifacts/brooswit-drovr-0.3.2.tgz`; it is intentionally ignored by Git.
After the reviewed source commit is merged and tagged `v0.3.2`, publish that
archive as the matching GitHub release asset. Consumers must update both their
dependency URL and lockfile to the new version. Do not replace the existing
release assets.
