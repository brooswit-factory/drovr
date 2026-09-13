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
    expect(await prepareAgyHome({ home, cwd, servers })).toEqual({ HOME: home });
    const path = join(home, ".gemini/config/mcp_config.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: servers });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(home, ".gemini/antigravity-cli/settings.json"), "utf8")).trustedWorkspaces).toEqual([cwd]);
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
