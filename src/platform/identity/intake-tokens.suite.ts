import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestDb, TestDbFactory } from '../testkit/db.js';
import { createIntakeToken, listIntakeTokens, revokeIntakeToken } from './intake-tokens.js';
import { hashIntakeToken } from './tokens.js';

export function intakeTokensSuite(name: string, make: TestDbFactory): void {
  describe(`intake tokens (${name})`, () => {
    let t: TestDb;
    beforeEach(async () => {
      t = await make();
    });
    afterEach(async () => {
      await t.destroy();
    });

    it('stores only the hash, reuses the person, lists without the hash', async () => {
      const a = await createIntakeToken(t.handle.db, 'alice-laptop', { expires: '90d' });
      await createIntakeToken(t.handle.db, 'alice-laptop', { samePerson: true });
      const row = await t.handle.db
        .selectFrom('api_token')
        .selectAll()
        .where('id', '=', a.id)
        .executeTakeFirstOrThrow();
      expect(row.token_hash).toBe(hashIntakeToken(a.token));
      expect(row.expires_at).not.toBeNull();
      const users = await t.handle.db
        .selectFrom('app_user')
        .select('id')
        .where('display_name', '=', 'alice-laptop')
        .execute();
      expect(users).toHaveLength(1);
      const list = await listIntakeTokens(t.handle.db);
      expect(list).toHaveLength(2);
      expect(JSON.stringify(list)).not.toContain(row.token_hash);
    });

    it('refuses an existing name without --same-person, and never attaches to the admin', async () => {
      await createIntakeToken(t.handle.db, 'carol');
      await expect(createIntakeToken(t.handle.db, 'carol')).rejects.toThrow(/--same-person/);
      // ensureLocalIdentity names the local admin "You".
      await expect(createIntakeToken(t.handle.db, 'You', { samePerson: true })).rejects.toThrow(
        /admin/,
      );
      expect(await listIntakeTokens(t.handle.db)).toHaveLength(1);
    });

    it('revokes by name once and rejects a bad expiry', async () => {
      await createIntakeToken(t.handle.db, 'bob');
      expect(await revokeIntakeToken(t.handle.db, 'bob')).toBe(1);
      expect(await revokeIntakeToken(t.handle.db, 'bob')).toBe(0);
      expect((await listIntakeTokens(t.handle.db))[0]?.revokedAt).not.toBeNull();
      await expect(createIntakeToken(t.handle.db, 'x', { expires: 'soon' })).rejects.toThrow(
        /--expires/,
      );
    });
  });
}
