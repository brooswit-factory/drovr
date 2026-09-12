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

`buildAgentStartParams` translates a typed Claude or Codex launch request into
Herdr's `agent.start` parameters. It does not select a provider or model and
does not fall back after failure.

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

These APIs require Drovr 0.2.0. The prepared immutable GitHub release asset is
`artifacts/brooswit-drovr-0.2.0.tgz`; it is intentionally ignored by Git.
After the reviewed source commit is merged and tagged `v0.2.0`, publish that
archive as the matching GitHub release asset. Consumers must update both their
dependency URL and lockfile to the new version. Do not replace the existing
0.1.0 asset.
