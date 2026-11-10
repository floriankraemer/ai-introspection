import { randomBytes } from 'node:crypto';
import type { Db } from '../db/schema.js';
import { newId } from '../db/ids.js';
import { LOCAL_WORKSPACE_ID } from './index.js';
import { hashIntakeToken } from './tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IntakeTokenRow {
  id: string;
  name: string;
  person: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** `90d` -> days; anything else is rejected so a typo never yields a token that never expires. */
export function parseExpiry(spec: string, now: Date): string {
  const m = /^(\d+)d$/.exec(spec);
  if (!m || Number(m[1]) < 1)
    throw new Error(`Invalid --expires "${spec}"; use a number of days like 90d.`);
  return new Date(now.getTime() + Number(m[1]) * 86_400_000).toISOString();
}

/**
 * Creates the token and a new person named `name`. An existing person gets another token only with
 * `samePerson`, and only when they are a member: an intake token never acts as the owner.
 * The plaintext is returned once, never stored.
 */
export async function createIntakeToken(
  db: Db,
  name: string,
  opts: { expires?: string | undefined; samePerson?: boolean; now?: Date } = {},
): Promise<{ token: string; id: string }> {
  const now = opts.now ?? new Date();
  const expiresAt = opts.expires === undefined ? null : parseExpiry(opts.expires, now);
  const createdAt = now.toISOString();
  const token = randomBytes(32).toString('hex');
  const id = newId();
  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('app_user')
      .select(['id', 'role'])
      .where('workspace_id', '=', LOCAL_WORKSPACE_ID)
      .where('display_name', '=', name)
      .executeTakeFirst();
    if (existing && existing.role !== 'member')
      throw new Error(
        `"${name}" is the name of this installation's ${existing.role}; pick another name for the person.`,
      );
    if (existing && opts.samePerson !== true)
      throw new Error(
        `A person named "${name}" already has a token. Pass --same-person to give them another one, or pick another name.`,
      );
    const userId = existing?.id ?? newId();
    if (!existing) {
      await trx
        .insertInto('app_user')
        .values({
          id: userId,
          workspace_id: LOCAL_WORKSPACE_ID,
          display_name: name,
          email: null,
          role: 'member',
          created_at: createdAt,
        })
        .execute();
    }
    await trx
      .insertInto('api_token')
      .values({
        id,
        workspace_id: LOCAL_WORKSPACE_ID,
        user_id: userId,
        name,
        token_hash: hashIntakeToken(token),
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null,
      })
      .execute();
  });
  return { token, id };
}

export async function listIntakeTokens(db: Db): Promise<IntakeTokenRow[]> {
  const rows = await db
    .selectFrom('api_token as t')
    .innerJoin('app_user as u', 'u.id', 't.user_id')
    .select([
      't.id',
      't.name',
      'u.display_name as person',
      't.created_at',
      't.expires_at',
      't.revoked_at',
    ])
    .where('t.workspace_id', '=', LOCAL_WORKSPACE_ID)
    .orderBy('t.created_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    person: r.person,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }));
}

/** Revokes by id or name; returns how many tokens were newly revoked. */
export async function revokeIntakeToken(
  db: Db,
  nameOrId: string,
  now = new Date(),
): Promise<number> {
  const res = await db
    .updateTable('api_token')
    .set({ revoked_at: now.toISOString() })
    .where('workspace_id', '=', LOCAL_WORKSPACE_ID)
    .where('revoked_at', 'is', null)
    // Postgres id is a uuid column; comparing it with a plain name would raise.
    .where((eb) =>
      UUID.test(nameOrId)
        ? eb.or([eb('id', '=', nameOrId), eb('name', '=', nameOrId)])
        : eb('name', '=', nameOrId),
    )
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/** Tokens that can push right now: not revoked and not expired. */
export async function countActiveIntakeTokens(db: Db, now = new Date()): Promise<number> {
  const { n } = await db
    .selectFrom('api_token')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('workspace_id', '=', LOCAL_WORKSPACE_ID)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now.toISOString())]))
    .executeTakeFirstOrThrow();
  return n;
}
