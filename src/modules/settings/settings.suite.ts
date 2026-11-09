import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretStore, createSettings, type SettingsService } from './index.js';
import { LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';

export function settingsSuite(name: string, make: TestDbFactory): void {
  describe(`settings repository (${name})`, () => {
    let t: TestDb;
    let dataDir: string;
    let settings: SettingsService;
    beforeEach(async () => {
      t = await make();
      dataDir = mkdtempSync(join(tmpdir(), 'introspect-settings-'));
      settings = createSettings(t.handle.db, LOCAL_WORKSPACE_ID, createSecretStore(dataDir));
    });
    afterEach(async () => {
      await t.destroy();
    });

    it('returns the defaults on an empty store', async () => {
      const s = await settings.get();
      expect(s['retention.days']).toBe(90);
      expect(s['setup.completed']).toBe(false);
      expect(s['redaction.enabled']).toBe(true);
      expect(s['budget.tokens_per_day']).toBe(1_000_000);
      expect(s['judge.api_key_set']).toBe(false);
    });

    it('persists a partial patch and keeps the other keys', async () => {
      await settings.update({ 'budget.usd_per_month': 25 });
      await settings.update({ 'retention.days': 30 });
      const fresh = createSettings(t.handle.db, LOCAL_WORKSPACE_ID, createSecretStore(dataDir));
      const s = await fresh.get();
      expect(s['budget.usd_per_month']).toBe(25);
      expect(s['retention.days']).toBe(30);
      expect(s['budget.mode']).toBe('tokens_day');
    });

    it('rejects values outside the documented range and stores nothing', async () => {
      await expect(settings.update({ 'retention.days': 3 })).rejects.toThrow();
      expect((await settings.get())['retention.days']).toBe(90);
    });

    it('rejects custom redaction patterns that can backtrack catastrophically', async () => {
      await expect(settings.update({ 'redaction.custom_patterns': ['(a+)+$'] })).rejects.toThrow();
      await expect(settings.update({ 'redaction.custom_patterns': ['('] })).rejects.toThrow();
      await settings.update({ 'redaction.custom_patterns': ['ACME-\\d{6}'] });
      expect((await settings.get())['redaction.custom_patterns']).toEqual(['ACME-\\d{6}']);
    });

    it('keeps the judge key write-only, in a 0600 file', async () => {
      settings.setJudgeKey('sk-ant-test-key-that-must-not-leak');
      const s = await settings.get();
      expect(s['judge.api_key_set']).toBe(true);
      expect(JSON.stringify(s)).not.toContain('must-not-leak');
      expect(statSync(join(dataDir, 'secrets')).mode & 0o777).toBe(0o600);
    });
  });
}
