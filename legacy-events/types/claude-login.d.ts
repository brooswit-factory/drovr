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
export type ClaudeLoginResult = {
    ok: true;
} | {
    ok: false;
    detail: string;
};
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
export declare function parseClaudeLoginUrl(raw: string): string | undefined;
export declare function startClaudeLogin(options?: StartClaudeLoginOptions, overrides?: Partial<ClaudeLoginDeps>): Promise<ClaudeLoginSession>;
