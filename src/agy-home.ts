import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { prepareManagedAgentWorkspace } from "./managed-workspace.js";

export interface AgyStdioServer {
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/** Caller supplies a private, dedicated home; never copy the user's MCP identity. */
export async function prepareAgyHome(options: {
  home: string;
  cwd: string;
  servers: Readonly<Record<string, AgyStdioServer>>;
}): Promise<{ HOME: string }> {
  if (!isAbsolute(options.home)) throw new Error("AGY home must be absolute");
  if (resolve(options.home) === resolve(homedir()) || resolve(options.home) === parse(options.home).root) {
    throw new Error("AGY home must be a dedicated directory");
  }
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  if (await realpath(options.home) !== resolve(options.home)) throw new Error("AGY home cannot contain symlinks");
  const config = join(options.home, ".gemini", "config");
  await mkdir(config, { recursive: true, mode: 0o700 });
  if (await realpath(config) !== config) throw new Error("AGY config cannot contain symlinks");
  await prepareManagedAgentWorkspace(
    { provider: "agy", cwd: options.cwd, unattended: true },
    join(options.home, ".gemini", "antigravity-cli", "settings.json"),
  );
  const file = await open(join(config, "mcp_config.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error("AGY MCP config must be a regular file");
    await file.chmod(0o600);
    await file.truncate();
    await file.writeFile(JSON.stringify({ mcpServers: options.servers }, null, 2) + "\n");
  } finally { await file.close(); }
  return { HOME: options.home };
}
