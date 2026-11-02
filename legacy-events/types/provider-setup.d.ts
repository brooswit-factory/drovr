export interface ProviderSetupFile {
    relative: string;
    contents: string;
}
/** Apply setup as the target user, preserving existing settings and refusing symlinks. */
export declare function applyProviderSetupSeed(home: string, files: ProviderSetupFile[]): Promise<void>;
/** Export only completed setup for a tenant using the same authenticated account.
 * Never manufacture consent or copy trust, MCP identities, or provider history.
 */
export declare function providerSetupSeed(provider: "agy" | "claude" | "codex", home: string): Promise<ProviderSetupFile[]>;
