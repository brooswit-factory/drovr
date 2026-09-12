import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { prepareManagedAgentWorkspace } from "../src/index.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "drovr-workspace-")));
  fixtures.push(root);
  const cwd = join(root, "factory", "TEST-1");
  const settingsPath = join(root, "config", "settings.json");
  await fs.mkdir(cwd, { recursive: true });
  const writeSettings = async (text: string) => {
    await fs.mkdir(dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, text);
  };
  const prepare = (directory = cwd) => prepareManagedAgentWorkspace({ provider: "agy", cwd: directory, unattended: true }, settingsPath);
  return { root, cwd, settingsPath, writeSettings, prepare };
}

describe("managed workspace preparation", () => {
  test("creates private settings for only the exact existing directory and is idempotent", async () => {
    const f = await fixture();
    await f.prepare();
    const original = await fs.readFile(f.settingsPath, "utf8");
    const before = await fs.stat(f.settingsPath);
    expect(JSON.parse(original)).toEqual({ trustedWorkspaces: [f.cwd] });
    expect(before.mode & 0o777).toBe(0o600);
    expect((await fs.stat(dirname(f.settingsPath))).mode & 0o777).toBe(0o700);
    await f.prepare();
    expect(await fs.readFile(f.settingsPath, "utf8")).toBe(original);
    expect((await fs.stat(f.settingsPath)).ino).toBe(before.ino);
    expect(await fs.readdir(dirname(f.settingsPath))).toEqual(["settings.json"]);
  });

  test("preserves unknown configuration and parent trust while adding the exact realpath child", async () => {
    const f = await fixture();
    const original = {
      trustedWorkspaces: [dirname(f.cwd), "/old/workspace"],
      theme: "dark",
      mcpServers: { butchr: { command: "bridge", args: ["--issue", "TEST-1"] } },
      unknown: { nested: [null, true, 7, { key: "value" }] },
    };
    await f.writeSettings(JSON.stringify(original));
    const alias = join(f.root, "workspace-link");
    await fs.symlink(f.cwd, alias);
    await f.prepare(alias);
    expect(JSON.parse(await fs.readFile(f.settingsPath, "utf8"))).toEqual({
      ...original, trustedWorkspaces: [...original.trustedWorkspaces, f.cwd],
    });
    expect((await fs.stat(f.settingsPath)).mode & 0o777).toBe(0o600);
    await f.prepare();
    expect(JSON.parse(await fs.readFile(f.settingsPath, "utf8")).trustedWorkspaces).toEqual([...original.trustedWorkspaces, f.cwd]);
  });

  test("serializes concurrent distinct directories and duplicate requests without lost entries", async () => {
    const f = await fixture();
    const directories = Array.from({ length: 12 }, (_, index) => join(f.root, "factory", `TEST-${index + 2}`));
    await Promise.all(directories.map(path => fs.mkdir(path)));
    await f.writeSettings(JSON.stringify({ trustedWorkspaces: [f.cwd], unknown: { preserve: true } }));
    await Promise.all([...directories, ...directories].map(path => f.prepare(path)));
    expect(JSON.parse(await fs.readFile(f.settingsPath, "utf8"))).toEqual({
      trustedWorkspaces: [f.cwd, ...directories], unknown: { preserve: true },
    });
    expect(await fs.readdir(dirname(f.settingsPath))).toEqual(["settings.json"]);
  });

  test.each([
    "", "{broken", "null", "[]", "true", '"settings"',
    '{"trustedWorkspaces":null}', '{"trustedWorkspaces":{}}',
    '{"trustedWorkspaces":"/work"}', '{"trustedWorkspaces":[3]}',
    '{"trustedWorkspaces":["relative/path"]}', '{"trustedWorkspaces":["/bad\\u0000path"]}',
  ])("malformed settings are not overwritten: %s", async text => {
    const f = await fixture();
    await f.writeSettings(text);
    const before = await fs.stat(f.settingsPath);
    await expect(f.prepare()).rejects.toThrow();
    expect(await fs.readFile(f.settingsPath, "utf8")).toBe(text);
    expect((await fs.stat(f.settingsPath)).ino).toBe(before.ino);
    expect(await fs.readdir(dirname(f.settingsPath))).toEqual(["settings.json"]);
  });

  test("a failed preparation does not block later queued work", async () => {
    const bad = await fixture();
    const good = await fixture();
    await bad.writeSettings("invalid");
    const results = await Promise.allSettled([bad.prepare(), good.prepare()]);
    expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(JSON.parse(await fs.readFile(good.settingsPath, "utf8"))).toEqual({ trustedWorkspaces: [good.cwd] });
  });

  test("other providers and AGY without explicit unattended true are filesystem no-ops", async () => {
    const f = await fixture();
    await f.writeSettings("malformed settings are never read by a no-op");
    const before = await fs.readFile(f.settingsPath, "utf8");
    for (const provider of ["claude", "codex", "agy"] as const) {
      for (const unattended of [undefined, false, true]) {
        if (provider === "agy" && unattended === true) continue;
        await prepareManagedAgentWorkspace({
          provider, cwd: "nonexistent/relative/path",
          ...(unattended === undefined ? {} : { unattended }),
        }, f.settingsPath);
      }
    }
    expect(await fs.readFile(f.settingsPath, "utf8")).toBe(before);
    expect(await fs.readdir(dirname(f.settingsPath))).toEqual(["settings.json"]);
  });

  test("rejects relative, missing, non-directory, root, home and home-ancestor workspaces before writing", async () => {
    const f = await fixture();
    const file = join(f.root, "file");
    await fs.writeFile(file, "not a directory");
    const homeLink = join(f.root, "home-link");
    await fs.symlink(homedir(), homeLink);
    for (const cwd of [".", join(f.root, "missing"), file, parse(f.root).root, homedir(), dirname(homedir()), homeLink]) {
      await expect(f.prepare(cwd)).rejects.toThrow();
    }
    expect(await fs.exists(dirname(f.settingsPath))).toBe(false);
  });

  test("refuses settings symlinks and directories without replacing them", async () => {
    const f = await fixture();
    await fs.mkdir(dirname(f.settingsPath), { recursive: true });
    const target = join(f.root, "other-settings.json");
    await fs.writeFile(target, "{}");
    await fs.symlink(target, f.settingsPath);
    await expect(f.prepare()).rejects.toThrow();
    expect((await fs.lstat(f.settingsPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("{}");
    await fs.unlink(f.settingsPath);
    await fs.mkdir(f.settingsPath);
    await expect(f.prepare()).rejects.toThrow();
    expect((await fs.stat(f.settingsPath)).isDirectory()).toBe(true);
  });

  test("atomic replacement failure preserves settings and removes its private temporary file", async () => {
    const f = await fixture();
    await f.writeSettings('{"unknown":"preserved"}');
    const before = await fs.readFile(f.settingsPath, "utf8");
    let temporaryMode: number | undefined;
    let replacement: unknown;
    const rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
      expect(target).toBe(f.settingsPath);
      expect(dirname(String(source))).toBe(dirname(f.settingsPath));
      temporaryMode = (await fs.stat(source)).mode & 0o777;
      replacement = JSON.parse(await fs.readFile(source, "utf8"));
      throw new Error("fixture rename failure");
    });
    try {
      await expect(f.prepare()).rejects.toThrow("fixture rename failure");
    } finally { rename.mockRestore(); }
    expect(temporaryMode).toBe(0o600);
    expect(replacement).toEqual({ unknown: "preserved", trustedWorkspaces: [f.cwd] });
    expect(await fs.readFile(f.settingsPath, "utf8")).toBe(before);
    expect(await fs.readdir(dirname(f.settingsPath))).toEqual(["settings.json"]);
  });
});
