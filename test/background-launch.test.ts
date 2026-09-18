import { describe, expect, test } from "bun:test";
import {
  buildBackgroundLaunchArgv, buildProviderLaunchArgs, launchBackgroundSession, parseBackgroundLaunchId,
  type BackgroundLaunchDeps, type ClaudeBackgroundListing, type ClaudeDaemonState,
} from "../src/index.js";

// Raw stdout of `FORCE_COLOR=3 claude --bg`, claude 2.1.276, 2026-09-18.
const COLOURED = "backgrounded · \x1b[36m582c43dc\x1b[39m\n\x1b[2m  claude agents             list sessions\x1b[22m\n"
  + "\x1b[2m  claude attach 582c43dc    open in this terminal\x1b[22m\n";
const PLAIN = "backgrounded · b4f56f3a\n  claude agents             list sessions\n";
// `claude logs` of a session blocked on an unapproved .mcp.json server (cursor-positioned words).
const MCP_PROMPT_SCREEN = "\x1b[3G\x1b[38;2;255;204;0m\x1b[1mNew\x1b[7GMCP\x1b[11Gserver\x1b[18Gfound\x1b[24Gin\x1b[27Gthis\x1b[32Gproject:\x1b[41Gprobe\x1b[22m\x1b[39m\n";
const DAEMON_CRASH = "bg settled 346c2970 (crashed): daemon binary was deleted (upgrade in progress) — run your command again to use the new version";

const sessionId = "582c43dc-f6cd-4d23-95bf-1cbe96ef0621";
const listed: ClaudeBackgroundListing = { id: "582c43dc", sessionId, cwd: "/work/repo", status: "idle" };
const sound: ClaudeDaemonState = { running: true, pid: 23539, version: "2.1.276", executable: "/v/2.1.276", binaryReplaced: false };

function harness(overrides: Partial<BackgroundLaunchDeps> & { listings?: ClaudeBackgroundListing[][] } = {}) {
  let clock = 0;
  const ran: { argv: readonly string[]; cwd: string }[] = [];
  const listings = overrides.listings ?? [[listed]];
  let listCall = 0;
  const deps: Partial<BackgroundLaunchDeps> = {
    run: async (argv, cwd) => { ran.push({ argv, cwd }); return { exitCode: 0, stdout: COLOURED, stderr: "" }; },
    listBackground: async () => listings[Math.min(listCall++, listings.length - 1)]!,
    readSessionScreen: async () => "",
    probeDaemon: async () => sound,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    listTimeoutMs: 1_000,
    settleMs: 500,
    pollMs: 100,
    ...overrides,
  };
  return { deps, ran };
}

describe("background launch argv", () => {
  test("every option precedes --bg and the prompt follows a separator", () => {
    expect(buildBackgroundLaunchArgv({
      provider: "claude", cwd: "/w", model: "opus", prompt: "-starts with a dash",
      mcpConfigPath: "/w/.mcp.json", mcpNotificationServers: ["yappr"],
    })).toEqual([
      "claude", "--model", "opus",
      "--mcp-config", "/w/.mcp.json",
      "--settings", '{"enabledMcpjsonServers":["yappr"]}',
      "--dangerously-load-development-channels=server:yappr",
      "--bg", "--", "-starts with a dash",
    ]);
  });

  test("a notifying server is approved with any the caller named, once each", () => {
    const argv = buildBackgroundLaunchArgv({ provider: "claude", cwd: "/w", mcpServersApproved: ["yappr", "docs"], mcpNotificationServers: ["yappr"] });
    expect(argv[argv.indexOf("--settings") + 1]).toBe('{"enabledMcpjsonServers":["yappr","docs"]}');
  });

  test("an idle launch is just claude --bg", () => {
    expect(buildBackgroundLaunchArgv({ provider: "claude", cwd: "/w" })).toEqual(["claude", "--bg"]);
  });

  test("approval is Claude's alone, and names must be plain identifiers", () => {
    expect(buildProviderLaunchArgs("agy", { mcpServersApproved: ["yappr"] })).toEqual([]);
    expect(() => buildProviderLaunchArgs("claude", { mcpServersApproved: ["a\",\"b"] })).toThrow("Unsupported MCP server name");
  });
});

describe("parseBackgroundLaunchId", () => {
  test("reads the id through FORCE_COLOR escapes", () => {
    expect(parseBackgroundLaunchId(COLOURED)).toBe("582c43dc");
    expect(parseBackgroundLaunchId(PLAIN)).toBe("b4f56f3a");
  });

  test("refuses anything that is not a launch line", () => {
    expect(parseBackgroundLaunchId("")).toBeUndefined();
    expect(parseBackgroundLaunchId("started 582c43dc")).toBeUndefined();
    expect(parseBackgroundLaunchId("backgrounded · 58;2c")).toBeUndefined();
  });
});

describe("launchBackgroundSession", () => {
  test("returns the clean short id and the listed session id", async () => {
    const { deps, ran } = harness();
    expect(await launchBackgroundSession({ provider: "claude", cwd: "/work/repo" }, deps)).toEqual({
      ok: true, provider: "claude", shortId: "582c43dc", sessionId, cwd: "/work/repo", state: "idle",
    });
    expect(ran).toEqual([{ argv: ["claude", "--bg"], cwd: "/work/repo" }]);
  });

  test("waits for a printed id to reach the listing", async () => {
    const { deps } = harness({ listings: [[], [], [listed]] });
    expect((await launchBackgroundSession({ provider: "claude", cwd: "/work/repo" }, deps)).ok).toBe(true);
  });

  test("an id no listing ever shows is reported, never guessed from the directory", async () => {
    const other = { ...listed, id: "0baa367f", sessionId: "0baa367f-11a3-4684-8161-36c781aa99f1" };
    const { deps } = harness({ listings: [[other]] });
    expect(await launchBackgroundSession({ provider: "claude", cwd: "/work/repo" }, deps)).toMatchObject({
      ok: false, reason: "unlisted", shortId: "582c43dc",
    });
  });

  test("refuses before launching when the daemon runs a deleted executable", async () => {
    const { deps, ran } = harness({
      probeDaemon: async () => ({ ...sound, executable: "/v/2.1.275 (deleted)", binaryReplaced: true }),
    });
    const result = await launchBackgroundSession({ provider: "claude", cwd: "/work/repo" }, deps);
    expect(result).toMatchObject({ ok: false, reason: "blocked", blocking: { kind: "daemon-binary-replaced", daemonPid: 23539 } });
    expect(ran).toEqual([]);
  });

  test("a launch that prints a host-wide condition is blocked, not failed", async () => {
    const { deps } = harness({ run: async () => ({ exitCode: 1, stdout: "", stderr: DAEMON_CRASH }) });
    expect(await launchBackgroundSession({ provider: "claude", cwd: "/work/repo" }, deps)).toMatchObject({
      ok: false, reason: "blocked", blocking: { kind: "daemon-binary-replaced" },
    });
  });

  test("any other refusal is failed, carrying the provider's own words", async () => {
    const { deps } = harness({ run: async () => ({ exitCode: 1, stdout: "", stderr: "Couldn't start a background session" }) });
    expect(await launchBackgroundSession({ provider: "claude", cwd: "/work/repo" }, deps)).toMatchObject({
      ok: false, reason: "failed", detail: expect.stringContaining("Couldn't start a background session"),
    });
  });

  test("a started session stuck on an MCP approval prompt is blocked, with its id to clean up", async () => {
    let reads = 0;
    const { deps } = harness({ readSessionScreen: async () => (++reads > 2 ? MCP_PROMPT_SCREEN : "") });
    expect(await launchBackgroundSession({ provider: "claude", cwd: "/work/repo" }, deps)).toMatchObject({
      ok: false, reason: "blocked", blocking: { kind: "mcp-approval-prompt" }, shortId: "582c43dc", sessionId,
    });
  });

  test("a first turn refused for an expired login is blocked", async () => {
    const { deps } = harness({ readSessionScreen: async () => "⎿  Login expired · Please run /login" });
    expect(await launchBackgroundSession({ provider: "claude", cwd: "/work/repo", prompt: "hi" }, deps)).toMatchObject({
      ok: false, reason: "blocked", blocking: { kind: "login-expired", detail: "⎿  Login expired · Please run /login" },
    });
  });

  test("codex and agy have no background session to start", async () => {
    const { deps, ran } = harness();
    expect(await launchBackgroundSession({ provider: "agy", cwd: "/w" }, deps)).toMatchObject({ ok: false, reason: "unsupported-provider" });
    expect(ran).toEqual([]);
  });
});
