import type { CodexAppServerRunner } from './codex-app-server.js';
import type { DeliveryOutcome } from './inbox-relay.js';
/** Serial relay acceptance, while model completion continues independently. */
export declare class CodexInbox {
    private readonly options;
    private busy;
    uncertain: boolean;
    constructor(options: {
        runner: () => Pick<CodexAppServerRunner, 'acceptMessage' | 'steer'>;
        ready: () => boolean;
        identity: () => string | undefined;
        remember: (id: string) => Promise<void>;
        onFailure: (error: unknown) => void;
    });
    private fail;
    deliver(text: string): Promise<DeliveryOutcome>;
}
