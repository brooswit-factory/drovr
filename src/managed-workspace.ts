import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { ManagedAgentProvider } from "./agent-runtime.js";

export interface ManagedAgentWorkspace {
  provider: ManagedAgentProvider;
  cwd: string;
  unattended?: boolean;
}

let pendingPreparation: Promise<void> = Promise.resolve();

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  let file;
  try {
    file = await open(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    if (!(await file.stat()).isFile()) throw new Error("AGY settings must be a regular file");
    let settings: unknown;
    try {
      settings = JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new Error("Cannot read valid AGY settings JSON");
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("AGY settings must be a JSON object");
    }
    const result = settings as Record<string, unknown>;
    if ("trustedWorkspaces" in result && (!Array.isArray(result.trustedWorkspaces)
      || !result.trustedWorkspaces.every(entry => typeof entry === "string" && isAbsolute(entry) && !entry.includes("\0")))) {
      throw new Error("AGY trustedWorkspaces must be an array of absolute paths");
    }
    return result;
  } finally {
    await file.close();
  }
}

async function prepareAgyWorkspace(cwd: string, settingsPath: string): Promise<void> {
  if (!isAbsolute(cwd)) throw new Error("Managed workspace must be an absolute directory path");
  const workspace = await realpath(cwd);
  if (!(await stat(workspace)).isDirectory()) throw new Error("Managed workspace must be an existing directory");
  const home = await realpath(homedir());
  if (workspace === parse(workspace).root || workspace === home || home.startsWith(`${workspace}${sep}`)) {
    throw new Error("Refusing broad root or home workspace trust");
  }
  const settings = await readSettings(settingsPath);
  const trustedWorkspaces = (settings.trustedWorkspaces ?? []) as string[];
  if (trustedWorkspaces.includes(workspace)) return;
  settings.trustedWorkspaces = [...trustedWorkspaces, workspace];

  const parent = dirname(settingsPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(settingsPath)}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, settingsPath);
  } finally {
    try {
      await file.close();
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}

/**
 * Prepare a caller-owned workspace after creation and before launch. AGY trust
 * is exact-path settings state, independent of permission-prompt CLI flags.
 * Calls are serialized within this process; settingsPath is a fixture override.
 */
export function prepareManagedAgentWorkspace(
  workspace: ManagedAgentWorkspace,
  settingsPath?: string,
): Promise<void> {
  if (workspace.provider !== "agy" || workspace.unattended !== true) return Promise.resolve();
  const cwd = workspace.cwd;
  const target = resolve(settingsPath ?? join(homedir(), ".gemini", "antigravity-cli", "settings.json"));
  const preparation = pendingPreparation.then(() => prepareAgyWorkspace(cwd, target));
  pendingPreparation = preparation.catch(() => {});
  return preparation;
}
