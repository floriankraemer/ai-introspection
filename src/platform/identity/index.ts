import type { Db } from '../db/schema.js';

/** Local mode has one fixed workspace and one fixed user (ADR-0003). */
export const LOCAL_WORKSPACE_ID = '00000000-0000-7000-8000-000000000001';
export const LOCAL_USER_ID = '00000000-0000-7000-8000-000000000002';

/** Idempotent; safe to run on every start and from several processes. */
export async function ensureLocalIdentity(db: Db, now = new Date()): Promise<void> {
  const createdAt = now.toISOString();
  await db
    .insertInto('workspace')
    .values({ id: LOCAL_WORKSPACE_ID, name: 'Local', created_at: createdAt })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db
    .insertInto('app_user')
    .values({
      id: LOCAL_USER_ID,
      workspace_id: LOCAL_WORKSPACE_ID,
      display_name: 'You',
      email: null,
      role: 'admin',
      created_at: createdAt,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}
