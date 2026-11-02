/** Operator override, independent of a host's desired state and idle policy. */
export interface InstanceFreezeState {
    version: 1;
    instanceId: string;
    frozen: boolean;
    updatedAt: string;
}
export declare class InstanceFrozenError extends Error {
    readonly instanceId: string;
    readonly code = "instance_frozen";
    constructor(instanceId: string);
}
export declare function freezeStateRoot(): string;
/** Host must use the same stable instance identity across provider switches/restarts. */
export declare class InstanceFreezeStore {
    readonly root: string;
    constructor(root?: string);
    private path;
    read(instanceId: string): Promise<InstanceFreezeState>;
    set(instanceId: string, frozen: boolean): Promise<InstanceFreezeState>;
    assertRunnable(instanceId: string): Promise<void>;
}
export declare const instanceFreezeStore: InstanceFreezeStore;
/** No desired-state mutation: unfreeze only removes this veto. */
export declare function instanceMayRun(desiredOn: boolean, sleeping: boolean, frozen: boolean): boolean;
/** Host stop callback must target only this instance and preserve its conversation.
 * Rechecks while frozen, so a racing in-flight launch is stopped on the next tick.
 * Unknown state also stops execution; report the error rather than silently thawing.
 */
export declare function watchInstanceFreeze(instanceId: string, stop: () => Promise<void>, options: {
    store?: InstanceFreezeStore;
    intervalMs?: number;
    onError: (error: unknown) => void;
}): {
    close(): void;
    check(): Promise<void>;
};
