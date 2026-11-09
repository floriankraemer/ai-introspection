import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSettings, type SettingsService } from './index.js';
import { LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';

export function settingsSuite(name: string, make: TestDbFactory): void {
  describe(`settings repository (${name})`, () => {
    let t: TestDb;
    let settings: SettingsService;
    beforeEach(async () => {
      t = await make();
      settings = createSettings(t.handle.db, LOCAL_WORKSPACE_ID);
    });
    afterEach(async () => {
      await t.destroy();
    });

    it('returns the ADR defaults on an empty store', async () => {
      const s = await settings.get();
      expect(s.retention.payload_days).toBe(90);
      expect(s.budget).toEqual({
        mode: 'tokens',
        tokens_per_day: 1_000_000,
        monthly_dollar_ceiling: null,
      });
    });

    it('persists a partial patch and keeps the rest of the group', async () => {
      await settings.update({ budget: { monthly_dollar_ceiling: 25 } });
      await settings.update({ retention: { payload_days: 30 } });
      const fresh = createSettings(t.handle.db, LOCAL_WORKSPACE_ID);
      const s = await fresh.get();
      expect(s.budget).toEqual({
        mode: 'tokens',
        tokens_per_day: 1_000_000,
        monthly_dollar_ceiling: 25,
      });
      expect(s.retention.payload_days).toBe(30);
    });

    it('rejects values outside the documented range and stores nothing', async () => {
      await expect(settings.update({ retention: { payload_days: 3 } })).rejects.toThrow();
      expect((await settings.get()).retention.payload_days).toBe(90);
    });
  });
}
