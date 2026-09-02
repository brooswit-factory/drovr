/**
 * The seam every DrovrClient call funnels through before reaching herdr.
 * Today it does nothing but invoke `invoke()` and return (or rethrow)
 * exactly what it produced — pure pass-through. DROVR-6's correction/
 * override registry hangs here: `identity` names which call is happening
 * (the service it belongs to, the method, and the args it was called
 * with), and `invoke` is the thing a registry entry can call, wrap, or
 * replace outright to observe or replace either the result or a thrown
 * error.
 */
export interface CallIdentity {
  readonly service: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export type Invoke = () => Promise<unknown>;

export type ChokePoint = (identity: CallIdentity, invoke: Invoke) => Promise<unknown>;

export const passThroughChokePoint: ChokePoint = (_identity, invoke) => invoke();
