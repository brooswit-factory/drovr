import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAgyHome } from "../src/agy-home.js";

test("isolated AGY home contains only its supplied MCP identity and exact workspace trust", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "drovr-home-"));
  try {
    const home = join(cwd, "home");
    const servers = { butchr: { command: "/usr/bin/bun", args: ["bridge.js"] } };
    expect(await prepareAgyHome({ home, cwd, servers, runIntegration: async () => { throw new Error("installer must be opt-in"); } })).toEqual({ HOME: home });
    const path = join(home, ".gemini/config/mcp_config.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: servers });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(home, ".gemini/antigravity-cli/settings.json"), "utf8")).trustedWorkspaces).toEqual([cwd]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("reuses completed setup only, preserves private trust/MCP, and installs official hooks with private HOME", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "drovr-home-setup-"));
  try {
    const home = join(cwd, "home");
    const source = join(cwd, "source");
    const sourcePrefix = join(source, ".gemini/antigravity-cli");
    await mkdir(join(sourcePrefix, "cache"), { recursive: true });
    const onboarding = { onboardingComplete: true, consumerOnboardingComplete: true, enterpriseOnboardingComplete: false };
    const sourceState = JSON.stringify({ ...onboarding, privateAccount: "never-copy" });
    const sourceSettings = JSON.stringify({ colorScheme: "dark", trustedWorkspaces: ["/source-only"], mcpServers: { source: {} }, credentials: "never-copy" });
    await writeFile(join(sourcePrefix, "cache/onboarding.json"), sourceState);
    await writeFile(join(sourcePrefix, "settings.json"), sourceSettings);
    const targetPrefix = join(home, ".gemini/antigravity-cli");
    await mkdir(targetPrefix, { recursive: true });
    await writeFile(join(targetPrefix, "settings.json"), JSON.stringify({ trustedWorkspaces: ["/existing"], privateSetting: true, mcpServers: { existing: {} } }));
    const servers = { butchr: { command: "bun", args: ["bridge.js"] } };
    let installs = 0;
    await prepareAgyHome({ home, cwd, servers, setupFromHome: source, installHerdrIntegration: true,
      runIntegration: async (argv, options) => {
        installs++;
        expect(argv).toEqual(["herdr", "integration", "install", "antigravity-cli"]);
        expect(options.cwd).toBe(cwd);
        expect(options.timeout).toBe(10_000);
        expect(options.env.HOME).toBe(home);
        expect(options.env.XDG_CONFIG_HOME).toBe(join(home, ".config"));
        expect(options.env.XDG_STATE_HOME).toBe(join(home, ".local/state"));
        expect(options.env.XDG_CACHE_HOME).toBe(join(home, ".cache"));
        expect(options.env.HERDR_CONFIG_PATH).toBe(join(home, ".config/herdr/config.toml"));
        expect(JSON.parse(await readFile(join(home, ".gemini/config/mcp_config.json"), "utf8"))).toEqual({ mcpServers: servers });
      },
    });
    expect(installs).toBe(1);
    expect(JSON.parse(await readFile(join(targetPrefix, "settings.json"), "utf8"))).toEqual({
      colorScheme: "dark", trustedWorkspaces: ["/existing", cwd], privateSetting: true, mcpServers: { existing: {} },
    });
    expect(JSON.parse(await readFile(join(targetPrefix, "cache/onboarding.json"), "utf8"))).toEqual(onboarding);
    expect(await readFile(join(sourcePrefix, "settings.json"), "utf8")).toBe(sourceSettings);
    expect(await readFile(join(sourcePrefix, "cache/onboarding.json"), "utf8")).toBe(sourceState);
    await prepareAgyHome({ home, cwd, servers, setupFromHome: source });
    expect(JSON.parse(await readFile(join(home, ".gemini/config/mcp_config.json"), "utf8"))).toEqual({ mcpServers: servers });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("incomplete source onboarding propagates without running integration or replacing private settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "drovr-home-incomplete-"));
  try {
    const home = join(cwd, "home");
    const source = join(cwd, "source");
    await mkdir(join(source, ".gemini/antigravity-cli/cache"), { recursive: true });
    await writeFile(join(source, ".gemini/antigravity-cli/cache/onboarding.json"), JSON.stringify({
      onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false,
    }));
    const servers = { butchr: { command: "bun", args: [] } };
    await prepareAgyHome({ home, cwd, servers });
    const settings = await readFile(join(home, ".gemini/antigravity-cli/settings.json"), "utf8");
    let called = false;
    await expect(prepareAgyHome({ home, cwd, servers, setupFromHome: source, installHerdrIntegration: true,
      runIntegration: async () => { called = true; },
    })).rejects.toThrow("Complete Antigravity onboarding");
    expect(called).toBe(false);
    expect(await readFile(join(home, ".gemini/antigravity-cli/settings.json"), "utf8")).toBe(settings);
    expect(JSON.parse(await readFile(join(home, ".gemini/config/mcp_config.json"), "utf8"))).toEqual({ mcpServers: servers });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("integration failure propagates instead of claiming a prepared home", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "drovr-home-install-failure-"));
  try {
    const failure = new Error("injected installer timeout");
    await expect(prepareAgyHome({ home: join(cwd, "home"), cwd, servers: {}, installHerdrIntegration: true,
      runIntegration: async () => { throw failure; },
    })).rejects.toBe(failure);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("refuses the real home and a symlinked MCP config without changing its target", async () => {
  await expect(prepareAgyHome({ home: homedir(), cwd: homedir(), servers: {} })).rejects.toThrow("dedicated");
  const cwd = await mkdtemp(join(tmpdir(), "drovr-home-guard-"));
  try {
    const home = join(cwd, "home");
    const config = join(home, ".gemini/config");
    await mkdir(config, { recursive: true });
    const target = join(cwd, "untouched.json");
    await writeFile(target, "original");
    await symlink(target, join(config, "mcp_config.json"));
    await expect(prepareAgyHome({ home, cwd, servers: {} })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("original");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
