import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { prepareManagedAgentWorkspace } from "./managed-workspace.js";
import { applyProviderSetupSeed, providerSetupSeed } from "./provider-setup.js";

type IntegrationRunner = (argv: readonly string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
}) => Promise<void>;

const runIntegration: IntegrationRunner = (argv, options) => new Promise((resolve, reject) => {
  execFile(argv[0]!, [...argv.slice(1)], { ...options, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, error => {
    if (error) reject(new Error("Private AGY Herdr integration installation failed or timed out"));
    else resolve();
  }).stdin?.end();
});

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
  /** Reuse only already-completed onboarding and theme from this account's home. */
  setupFromHome?: string;
  installHerdrIntegration?: boolean;
  /** Installer I/O injection; unused unless integration installation is enabled. */
  runIntegration?: IntegrationRunner;
}): Promise<{ HOME: string }> {
  if (!isAbsolute(options.home)) throw new Error("AGY home must be absolute");
  if (resolve(options.home) === resolve(homedir()) || resolve(options.home) === parse(options.home).root) {
    throw new Error("AGY home must be a dedicated directory");
  }
  const setup = options.setupFromHome === undefined ? [] : await providerSetupSeed("agy", options.setupFromHome);
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  if (await realpath(options.home) !== resolve(options.home)) throw new Error("AGY home cannot contain symlinks");
  const config = join(options.home, ".gemini", "config");
  await mkdir(config, { recursive: true, mode: 0o700 });
  if (await realpath(config) !== config) throw new Error("AGY config cannot contain symlinks");
  await applyProviderSetupSeed(options.home, setup);
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
  if (options.installHerdrIntegration) {
    await (options.runIntegration ?? runIntegration)(["herdr", "integration", "install", "antigravity-cli"], {
      cwd: options.cwd,
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: options.home,
        XDG_CONFIG_HOME: join(options.home, ".config"),
        XDG_STATE_HOME: join(options.home, ".local/state"),
        XDG_CACHE_HOME: join(options.home, ".cache"),
        HERDR_CONFIG_PATH: join(options.home, ".config/herdr/config.toml"),
      },
    });
  }
  return { HOME: options.home };
}
