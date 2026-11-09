import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';

/** Fixed forever: changing it changes every session ID and breaks de-duplication. */
const SESSION_NAMESPACE = 'b6a0e6f2-3d1c-5f0e-9a41-7c2d8e5b1a90';

/** Time-ordered ID for every row except sessions (ADR-0003). */
export function newId(): string {
  return uuidv7();
}

/** Deterministic session ID, so re-imports and team shipping de-duplicate (ADR-0003). */
export function sessionId(agent: string, nativeId: string): string {
  return uuidv5(`${agent}\u0000${nativeId}`, SESSION_NAMESPACE);
}
