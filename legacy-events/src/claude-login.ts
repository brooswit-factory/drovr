import { claudeLoggedIn, plainOutputEnv, stripTerminalEscapes } from "./blocking-conditions.js";

/** The PTY a login runs in; injectable so the flow is testable without a real login. */
export interface ClaudeLoginTerminal {
  write(data: string): void;
  /** Everything the login has printed so far, raw. */
  output(): string;
  exited: Promise<number>;
  close(): Promise<void>;
}

export interface ClaudeLoginDeps {
  openTerminal(argv: readonly string[]): ClaudeLoginTerminal;
  loggedIn(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type ClaudeLoginResult = { ok: true } | { ok: false; detail: string };

/**
 * One headless re-authentication. Claude's login needs a TTY and a human: it
 * prints an authorize URL, the human approves it in any browser and is shown a
 * code, and the code is pasted back into the same process. This holds that
 * process open between the two halves so a host can relay the URL out and the
 * code back, which is how an expired servyboi fleet was recovered by hand.
 */
export interface ClaudeLoginSession {
  /** The authorize URL to open in any browser, on any machine. */
  readonly url: string;
  /** Paste the code the browser showed; resolves once the login is proven. */
  submitCode(code: string, timeoutMs?: number): Promise<ClaudeLoginResult>;
  /** Abandon the login; the stored credentials are left as they were. */
  cancel(): Promise<void>;
}

export interface StartClaudeLoginOptions {
  /** `claudeai` is a Claude subscription (the default); `console` bills the API. */
  method?: "claudeai" | "console";
  /** How long to wait for the authorize URL to print. */
  urlTimeoutMs?: number;
}

// Measured on claude 2.1.276: the URL follows "visit: " as an OSC 8 hyperlink
// whose visible text is the URL itself, then "Paste code here if prompted > ".
const AUTHORIZE_URL = /visit:\s*(https:\/\/\S+)/;
const CODE_PROMPT = /Paste code here/;
const POLL_MS = 100;

export function parseClaudeLoginUrl(raw: string): string | undefined {
  const text = stripTerminalEscapes(raw);
  return CODE_PROMPT.test(text) ? text.match(AUTHORIZE_URL)?.[1] : undefined;
}

function realTerminal(argv: readonly string[]): ClaudeLoginTerminal {
  let output = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn([...argv], {
    // A login run from inside a session would otherwise open a browser on the
    // host and colour the prompt this parses.
    env: { ...plainOutputEnv(), BROWSER: "true" },
    terminal: { cols: 4096, rows: 50, data(_terminal, data) { output += decoder.decode(data, { stream: true }); } },
  });
  return {
    write: (data) => { child.terminal!.write(data); },
    output: () => output,
    exited: child.exited,
    close: async () => {
      child.kill();
      await child.exited;
      child.terminal!.close();
    },
  };
}

const realDeps: ClaudeLoginDeps = {
  openTerminal: realTerminal,
  loggedIn: () => claudeLoggedIn(),
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
};

export async function startClaudeLogin(
  options: StartClaudeLoginOptions = {},
  overrides: Partial<ClaudeLoginDeps> = {},
): Promise<ClaudeLoginSession> {
  const deps = { ...realDeps, ...overrides };
  const terminal = deps.openTerminal(["claude", "auth", "login", `--${options.method ?? "claudeai"}`]);
  let exitCode: number | undefined;
  void terminal.exited.then((code) => { exitCode = code; });

  const urlDeadline = deps.now() + (options.urlTimeoutMs ?? 30_000);
  let url: string | undefined;
  while (!(url = parseClaudeLoginUrl(terminal.output()))) {
    if (exitCode !== undefined || deps.now() >= urlDeadline) {
      await terminal.close();
      throw new Error(`claude auth login printed no authorize URL: ${JSON.stringify(stripTerminalEscapes(terminal.output()).trim())}`);
    }
    await deps.sleep(POLL_MS);
  }

  return {
    url,
    submitCode: async (code, timeoutMs = 60_000) => {
      const trimmed = code.trim();
      if (!trimmed || /[\s\0-\x1f\x7f]/.test(trimmed)) {
        return { ok: false, detail: "A login code is one token with no whitespace or control characters" };
      }
      const before = terminal.output().length;
      terminal.write(`${trimmed}\r`);
      const deadline = deps.now() + timeoutMs;
      while (exitCode === undefined && deps.now() < deadline) await deps.sleep(POLL_MS);
      const printed = stripTerminalEscapes(terminal.output().slice(before)).trim();
      // Closing an exited login only releases its PTY, which otherwise holds the host open.
      await terminal.close();
      if (exitCode === undefined) {
        return { ok: false, detail: `claude auth login did not finish within ${timeoutMs}ms: ${JSON.stringify(printed)}` };
      }
      // The exit code alone is the CLI's claim; the stored status is the proof.
      if (exitCode === 0 && await deps.loggedIn()) return { ok: true };
      return { ok: false, detail: `claude auth login exited ${exitCode}: ${JSON.stringify(printed)}` };
    },
    cancel: () => terminal.close(),
  };
}
