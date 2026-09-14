import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerSetupSeed, applyProviderSetupSeed } from "../src/provider-setup";

test("repair preserves target preferences and rejects symlink writes", async () => {
  const home = await mkdtemp(join(tmpdir(), "drovr-repair-"));
  const path = join(home, ".gemini/antigravity-cli/settings.json");
  const files = [{ relative: ".gemini/antigravity-cli/settings.json", contents: '{"colorScheme":"terminal"}' }];
  try {
    await applyProviderSetupSeed(home, files);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ colorScheme: "terminal" });
    await writeFile(path, '{"colorScheme":"dark","trustedWorkspaces":["/keep"]}');
    await applyProviderSetupSeed(home, files);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ colorScheme: "dark", trustedWorkspaces: ["/keep"] });
    await rm(path);
    await writeFile(join(home, "outside"), '{}');
    await symlink(join(home, "outside"), path);
    await expect(applyProviderSetupSeed(home, files)).rejects.toThrow();
    expect(await readFile(join(home, "outside"), "utf8")).toBe('{}');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("AGY setup preserves completed choices without leaking trust or MCP settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "drovr-setup-"));
  const prefix = join(home, ".gemini/antigravity-cli");
  await mkdir(join(prefix, "cache"), { recursive: true });
  try {
    const state = { consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true };
    await writeFile(join(prefix, "cache/onboarding.json"), JSON.stringify({ ...state, secret: "omit" }));
    await writeFile(join(prefix, "settings.json"), JSON.stringify({ colorScheme: "dark", trustedWorkspaces: ["/"], mcpServers: { secret: {} } }));
    const files = await providerSetupSeed("agy", home);
    expect(JSON.parse(files[0]!.contents)).toEqual(state);
    expect(JSON.parse(files[1]!.contents)).toEqual({ colorScheme: "dark" });
    await writeFile(join(prefix, "cache/onboarding.json"), JSON.stringify({ ...state, onboardingComplete: false }));
    await expect(providerSetupSeed("agy", home)).rejects.toThrow("will not accept terms");
    await rm(join(prefix, "cache/onboarding.json"));
    await symlink(join(prefix, "settings.json"), join(prefix, "cache/onboarding.json"));
    await expect(providerSetupSeed("agy", home)).rejects.toThrow();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Claude requires existing completion; Codex needs no fabricated setup", async () => {
  const home = await mkdtemp(join(tmpdir(), "drovr-setup-"));
  try {
    expect(await providerSetupSeed("codex", home)).toEqual([]);
    await writeFile(join(home, ".claude.json"), '{"hasCompletedOnboarding":false}');
    await expect(providerSetupSeed("claude", home)).rejects.toThrow("Complete Claude onboarding");
    await writeFile(join(home, ".claude.json"), '{"hasCompletedOnboarding":true,"mcpServers":{}}');
    expect(JSON.parse((await providerSetupSeed("claude", home))[0]!.contents)).toEqual({ hasCompletedOnboarding: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});
