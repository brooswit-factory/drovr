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

AGY launches inherit the pane's working directory and use external MCP
configuration, which can connect a stdio-to-HTTP bridge. Drovr supplies no cwd
or MCP CLI override. `AgyAgentLaunch.skipPermissions` defaults to false; only
explicit `true` adds AGY's `--dangerously-skip-permissions` flag. Permission
policy belongs to the caller. This option does not configure workspace trust.

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
requires 0.3.1. See the [changelog](changelog.md). The prepared immutable GitHub
release asset is `artifacts/brooswit-drovr-0.3.1.tgz`; it is intentionally ignored
by Git. After the reviewed source commit is merged and tagged `v0.3.1`, publish that
archive as the matching GitHub release asset. Consumers must update both their
dependency URL and lockfile to the new version. Do not replace the existing
release assets.
