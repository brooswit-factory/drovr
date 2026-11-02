type IntegrationRunner = (argv: readonly string[], options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
}) => Promise<void>;
export interface AgyStdioServer {
    command: string;
    args: readonly string[];
    env?: Readonly<Record<string, string>>;
}
/** Caller supplies a private, dedicated home; never copy the user's MCP identity. */
export declare function prepareAgyHome(options: {
    home: string;
    cwd: string;
    servers: Readonly<Record<string, AgyStdioServer>>;
    /** Reuse only already-completed onboarding and theme from this account's home. */
    setupFromHome?: string;
    installHerdrIntegration?: boolean;
    /** Installer I/O injection; unused unless integration installation is enabled. */
    runIntegration?: IntegrationRunner;
}): Promise<{
    HOME: string;
}>;
export {};
