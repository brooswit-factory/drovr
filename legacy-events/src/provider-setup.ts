import { constants } from "node:fs";
import { open, mkdir, lstat } from "node:fs/promises";
import { join, dirname, relative, isAbsolute } from "node:path";

export interface ProviderSetupFile { relative: string; contents: string }

/** Apply setup as the target user, preserving existing settings and refusing symlinks. */
export async function applyProviderSetupSeed(home: string, files: ProviderSetupFile[]): Promise<void> {
  if (!isAbsolute(home) || !(await lstat(home)).isDirectory()) throw new Error("Invalid setup home");
  for (const seed of files) {
    if (![".claude.json", ".gemini/antigravity-cli/settings.json", ".gemini/antigravity-cli/cache/onboarding.json"].includes(seed.relative)) throw new Error("Invalid setup destination");
    const path = join(home, seed.relative);
    let parent = home;
    for (const part of relative(home, dirname(path)).split("/").filter(Boolean)) {
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      if (!(await lstat(parent)).isDirectory()) throw new Error("Setup directories cannot be symlinks");
    }
    const incoming = JSON.parse(seed.contents) as Record<string, unknown>;
    let existing: Record<string, unknown> = {};
    try { existing = await readObject(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Keep an existing theme; onboarding completion is supplied by the authenticated source.
    const value = seed.relative.endsWith("settings.json") ? { ...incoming, ...existing } : { ...existing, ...incoming };
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Setup must be a regular file");
      await file.truncate();
      await file.writeFile(JSON.stringify(value) + "\n");
      await file.sync();
    } finally { await file.close(); }
  }
}

async function readObject(path: string): Promise<Record<string, unknown>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Invalid provider setup file");
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provider setup object");
    return value as Record<string, unknown>;
  } finally { await file.close(); }
}

/** Export only completed setup for a tenant using the same authenticated account.
 * Never manufacture consent or copy trust, MCP identities, or provider history.
 */
export async function providerSetupSeed(provider: "agy" | "claude" | "codex", home: string): Promise<ProviderSetupFile[]> {
  if (provider === "codex") return [];
  if (provider === "claude") {
    const settings = await readObject(join(home, ".claude.json"));
    if (settings.hasCompletedOnboarding !== true) throw new Error("Complete Claude onboarding in the source account first");
    return [{ relative: ".claude.json", contents: '{"hasCompletedOnboarding":true}\n' }];
  }
  const prefix = ".gemini/antigravity-cli";
  const state = await readObject(join(home, prefix, "cache/onboarding.json"));
  const keys = ["consumerOnboardingComplete", "enterpriseOnboardingComplete", "onboardingComplete"];
  if (keys.some(key => typeof state[key] !== "boolean") || state.onboardingComplete !== true
    || !(state.consumerOnboardingComplete || state.enterpriseOnboardingComplete)) {
    throw new Error("Complete Antigravity onboarding in the source account first; Drovr will not accept terms or enable data sharing");
  }
  let settings: Record<string, unknown> = {};
  try { settings = await readObject(join(home, prefix, "settings.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (settings.colorScheme !== undefined && typeof settings.colorScheme !== "string") throw new Error("Invalid AGY color scheme");
  return [
    { relative: `${prefix}/cache/onboarding.json`, contents: JSON.stringify(Object.fromEntries(keys.map(key => [key, state[key]]))) + "\n" },
    { relative: `${prefix}/settings.json`, contents: JSON.stringify({ colorScheme: settings.colorScheme ?? "terminal" }) + "\n" },
  ];
}
