import { describe, expect, test } from "bun:test";
import {
  classifyBlockingText, classifyClaudeTranscriptRecord, daemonBlockingCondition, plainOutputEnv, probeClaudeDaemon,
  parseClaudeLoginUrl, startClaudeLogin, type ClaudeLoginTerminal,
} from "../src/index.js";

// `claude daemon status`, claude 2.1.276, 2026-09-18.
const DAEMON_STATUS = `pid:     23539
version: 2.1.276
uptime:  743s
origin:  transient — started on-demand by \`claude\` (pid 9758) in /home/brooswit/code/brooswit
`;

describe("classifyBlockingText", () => {
  test("recognises each measured condition", () => {
    expect(classifyBlockingText("claude", "Login expired · Please run /login")?.kind).toBe("login-expired");
    expect(classifyBlockingText("claude", 'Failed to authenticate. API Error: 401 {"type":"error"}')?.kind).toBe("login-expired");
    expect(classifyBlockingText("claude", "bg settled 346c2970 (crashed): daemon binary was deleted (upgrade in progress) — run your command again")?.kind)
      .toBe("daemon-binary-replaced");
    expect(classifyBlockingText("claude", "\x1b[1mNew\x1b[7GMCP\x1b[11Gserver\x1b[18Gfound\x1b[24Gin\x1b[27Gthis\x1b[32Gproject:")?.kind)
      .toBe("mcp-approval-prompt");
  });

  test("leaves ordinary failures to the caller", () => {
    expect(classifyBlockingText("claude", "You've hit your limit · resets 9am (America/Los_Angeles)")).toBeUndefined();
    expect(classifyBlockingText("claude", "")).toBeUndefined();
  });
});

describe("classifyClaudeTranscriptRecord", () => {
  const refused = {
    type: "assistant", isApiErrorMessage: true, error: "authentication_failed",
    message: { role: "assistant", content: [{ type: "text", text: "Login expired · Please run /login" }] },
  };

  test("reads Claude's own error tag", () => {
    expect(classifyClaudeTranscriptRecord(refused)).toEqual({ kind: "login-expired", provider: "claude", detail: "Login expired · Please run /login" });
  });

  test("a tool result quoting the same words is not a refusal", () => {
    expect(classifyClaudeTranscriptRecord({ type: "user", message: { content: [{ type: "tool_result", content: "Login expired · Please run /login" }] } }))
      .toBeUndefined();
    expect(classifyClaudeTranscriptRecord({ ...refused, error: "rate_limit" })).toBeUndefined();
  });
});

describe("probeClaudeDaemon", () => {
  const run = async () => ({ exitCode: 0, stdout: DAEMON_STATUS, stderr: "" });

  test("a daemon on its installed executable is sound", async () => {
    const state = await probeClaudeDaemon({ runClaude: run, readExecutable: async () => "/v/2.1.276" });
    expect(state).toEqual({ running: true, pid: 23539, version: "2.1.276", executable: "/v/2.1.276", binaryReplaced: false });
    expect(daemonBlockingCondition(state)).toBeUndefined();
  });

  test("a daemon whose executable was replaced blocks every launch", async () => {
    const state = await probeClaudeDaemon({ runClaude: run, readExecutable: async () => "/v/2.1.275 (deleted)" });
    expect(daemonBlockingCondition(state)).toMatchObject({ kind: "daemon-binary-replaced", daemonPid: 23539, daemonVersion: "2.1.276" });
  });

  test("no daemon is not a blocking condition", async () => {
    const state = await probeClaudeDaemon({ runClaude: async () => ({ exitCode: 1, stdout: "", stderr: "no daemon" }), readExecutable: async () => undefined });
    expect(state).toEqual({ running: false });
    expect(daemonBlockingCondition(state)).toBeUndefined();
  });
});

test("plainOutputEnv drops only FORCE_COLOR", () => {
  expect(plainOutputEnv({ FORCE_COLOR: "3", PATH: "/bin", UNSET: undefined })).toEqual({ PATH: "/bin" });
});

// `claude auth login --claudeai` in a PTY, claude 2.1.276 (URL shortened; OSC 8 link kept).
const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=abc";
const LOGIN_PROMPT = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${URL}\x07${URL}\x1b]8;;\x07\r\nPaste code here if prompted > `;

function fakeLogin(options: { printed?: string; onCode?: (code: string) => { exit: number; print?: string } | undefined } = {}) {
  let output = "";
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const writes: string[] = [];
  let closed = false;
  const terminal: ClaudeLoginTerminal = {
    write: (data) => {
      writes.push(data);
      const outcome = options.onCode?.(data.replace(/\r$/, ""));
      if (outcome) { output += outcome.print ?? ""; finish(outcome.exit); }
    },
    output: () => output,
    exited,
    close: async () => { closed = true; },
  };
  let clock = 0;
  const argv: (readonly string[])[] = [];
  return {
    writes, argv, closed: () => closed,
    deps: {
      openTerminal: (a: readonly string[]) => { argv.push(a); output = options.printed ?? LOGIN_PROMPT; return terminal; },
      loggedIn: async () => true,
      sleep: async (ms: number) => { clock += ms; await Promise.resolve(); },
      now: () => clock,
    },
  };
}

describe("startClaudeLogin", () => {
  test("parses the authorize URL out of its hyperlink", () => {
    expect(parseClaudeLoginUrl(LOGIN_PROMPT)).toBe(URL);
    expect(parseClaudeLoginUrl("Opening browser to sign in…")).toBeUndefined();
  });

  test("relays the URL out and the code back, and proves the login", async () => {
    const login = fakeLogin({ onCode: (code) => (code === "abc#def" ? { exit: 0, print: "Login successful" } : undefined) });
    const session = await startClaudeLogin({}, login.deps);
    expect(login.argv).toEqual([["claude", "auth", "login", "--claudeai"]]);
    expect(session.url).toBe(URL);
    expect(await session.submitCode("  abc#def\n")).toEqual({ ok: true });
    expect(login.writes).toEqual(["abc#def\r"]);
    expect(login.closed()).toBe(true);
  });

  test("a rejected code is reported with what the CLI printed", async () => {
    const login = fakeLogin({ onCode: () => ({ exit: 1, print: "Invalid code" }) });
    const session = await startClaudeLogin({}, login.deps);
    expect(await session.submitCode("nope")).toEqual({ ok: false, detail: 'claude auth login exited 1: "Invalid code"' });
  });

  test("an exit the stored status does not confirm is not a login", async () => {
    const login = fakeLogin({ onCode: () => ({ exit: 0 }) });
    const session = await startClaudeLogin({}, { ...login.deps, loggedIn: async () => false });
    expect((await session.submitCode("abc")).ok).toBe(false);
  });

  test("a code that could drive the terminal is refused unsent", async () => {
    const login = fakeLogin();
    const session = await startClaudeLogin({}, login.deps);
    expect((await session.submitCode("abc\x1b[A")).ok).toBe(false);
    expect(login.writes).toEqual([]);
  });

  test("no URL within the deadline is an error, not a hang", async () => {
    const login = fakeLogin({ printed: "Opening browser to sign in…" });
    await expect(startClaudeLogin({ urlTimeoutMs: 1_000 }, login.deps)).rejects.toThrow("printed no authorize URL");
    expect(login.closed()).toBe(true);
  });
});
