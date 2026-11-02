import type { CodexAppServerRunner } from './codex-app-server.js';
import type { DeliveryOutcome } from './inbox-relay.js';

/** Serial relay acceptance, while model completion continues independently. */
export class CodexInbox {
  private busy = false;
  uncertain = false;
  constructor(private readonly options: {
    runner: () => Pick<CodexAppServerRunner, 'acceptMessage' | 'steer'>;
    ready: () => boolean;
    identity: () => string | undefined;
    remember: (id: string) => Promise<void>;
    onFailure: (error: unknown) => void;
  }) {}

  private fail(error: unknown): void {
    this.uncertain = true;
    this.options.onFailure(error);
  }

  async deliver(text: string): Promise<DeliveryOutcome> {
    if (this.uncertain) return {status:'uncertain',detail:'Previous turn failed; inspection required'};
    if (!this.options.ready()) return {status:'busy'};
    try {
      if (this.busy) {
        return await this.options.runner().steer(text) ? {status:'delivered'} : {status:'busy'};
      }
      this.busy = true;
      const accepted = await this.options.runner().acceptMessage(text, this.options.identity());
      // Attach immediately: completion can precede the acknowledgement or disk write.
      void accepted.completed.then(
        () => { this.busy = false; },
        error => { this.busy = false; this.fail(error); },
      );
      await this.options.remember(accepted.conversationId);
      return {status:'delivered'};
    } catch (error) {
      this.fail(error);
      return {status:'uncertain',detail:String(error)};
    }
  }
}
