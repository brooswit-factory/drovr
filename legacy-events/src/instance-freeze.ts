import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** Operator override, independent of a host's desired state and idle policy. */
export interface InstanceFreezeState { version: 1; instanceId: string; frozen: boolean; updatedAt: string }
export class InstanceFrozenError extends Error {
  readonly code = 'instance_frozen';
  constructor(readonly instanceId: string) { super(`Instance is frozen: ${instanceId}`); this.name = 'InstanceFrozenError'; }
}
export function freezeStateRoot(): string {
  return process.env.DROVR_CONTROL_HOME || (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'drovr', 'control')
    : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'drovr', 'control'));
}
function identity(instanceId: string): string {
  if (!instanceId || instanceId.length > 512 || /[\x00-\x20\x7f]/.test(instanceId) || !instanceId.includes(':'))
    throw new Error('Instance ID must be a namespaced stable ID, e.g. candlestix:@agent-id');
  return instanceId;
}
/** Host must use the same stable instance identity across provider switches/restarts. */
export class InstanceFreezeStore {
  constructor(readonly root = freezeStateRoot()) {
    if (!isAbsolute(root)) throw new Error('Drovr control home must be absolute');
  }
  private path(instanceId: string): string { return join(this.root, createHash('sha256').update(identity(instanceId)).digest('hex') + '.json'); }
  async read(instanceId: string): Promise<InstanceFreezeState> {
    const key = identity(instanceId);
    let raw: string;
    try { raw = await readFile(this.path(key), 'utf8'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {version:1,instanceId:key,frozen:false,updatedAt:''};
      throw e; // Unknown/corrupt state must never permit a wake.
    }
    const value = JSON.parse(raw) as InstanceFreezeState;
    if (!value || value.version !== 1 || value.instanceId !== key || typeof value.frozen !== 'boolean' || typeof value.updatedAt !== 'string')
      throw new Error('Invalid instance freeze state');
    return value;
  }
  async set(instanceId: string, frozen: boolean): Promise<InstanceFreezeState> {
    const value: InstanceFreezeState = {version:1,instanceId:identity(instanceId),frozen,updatedAt:new Date().toISOString()};
    const path = this.path(instanceId), temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), {recursive:true,mode:0o700});
    try { await writeFile(temporary, JSON.stringify(value)+'\n', {flag:'wx',mode:0o600}); await rename(temporary,path); }
    finally { await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
    return value;
  }
  async assertRunnable(instanceId: string): Promise<void> {
    if ((await this.read(instanceId)).frozen) throw new InstanceFrozenError(instanceId);
  }
}
export const instanceFreezeStore = new InstanceFreezeStore();

/** No desired-state mutation: unfreeze only removes this veto. */
export function instanceMayRun(desiredOn: boolean, sleeping: boolean, frozen: boolean): boolean {
  return desiredOn && !sleeping && !frozen;
}

/** Host stop callback must target only this instance and preserve its conversation.
 * Rechecks while frozen, so a racing in-flight launch is stopped on the next tick.
 * Unknown state also stops execution; report the error rather than silently thawing.
 */
export function watchInstanceFreeze(instanceId: string, stop: () => Promise<void>, options: {
  store?: InstanceFreezeStore; intervalMs?: number; onError: (error: unknown) => void;
}): { close(): void; check(): Promise<void> } {
  const store = options.store ?? instanceFreezeStore;
  const interval = options.intervalMs ?? 1000;
  if (!Number.isFinite(interval) || interval < 10) throw new Error('Invalid freeze check interval');
  let checking: Promise<void> | undefined;
  const check = (): Promise<void> => checking ??= (async()=>{
    let frozen = true;
    try { frozen = (await store.read(instanceId)).frozen; } catch(e) { options.onError(e); }
    if (frozen) { try { await stop(); } catch(e) { options.onError(e); } }
  })().finally(()=>{checking=undefined;});
  const timer = setInterval(()=>{void check();},interval); timer.unref();
  return {close:()=>clearInterval(timer),check};
}
