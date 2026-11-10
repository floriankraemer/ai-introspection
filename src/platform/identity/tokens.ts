import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/schema.js';

/** Intake tokens are stored as hex SHA-256 digests only; the plain token is shown once at creation. */
export function hashIntakeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The person an intake token belongs to, or null when it is unknown, revoked or expired. */
export async function findIntakeToken(
  db: Db,
  workspaceId: string,
  token: string,
  now: Date = new Date(),
): Promise<{ userId: string; tokenId: string } | null> {
  if (token === '') return null;
  const hash = hashIntakeToken(token);
  const row = await db
    .selectFrom('api_token')
    .select(['id', 'user_id', 'token_hash', 'expires_at'])
    .where('workspace_id', '=', workspaceId)
    .where('token_hash', '=', hash)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;
  // The lookup already matched; the compare keeps the decision itself constant-time.
  const stored = Buffer.from(row.token_hash, 'hex');
  const given = Buffer.from(hash, 'hex');
  if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null;
  if (row.expires_at !== null && Date.parse(row.expires_at) <= now.getTime()) return null;
  return { userId: row.user_id, tokenId: row.id };
}
