import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_WORKSPACE_ID } from '../identity/index.js';
import { createJobQueue, type JobQueue } from '../jobs/queue.js';
import { createScheduler, type Schedule } from '../jobs/scheduler.js';
import type { TestDb, TestDbFactory } from './db.js';

const DAILY_0600 = '0 6 * * *';

export function schedulerSuite(name: string, make: TestDbFactory): void {
  describe(`scheduler (${name})`, () => {
    let t: TestDb;
    let queue: JobQueue;
    let cron: string | null;
    let schedule: Schedule;
    beforeEach(async () => {
      t = await make();
      queue = createJobQueue(t.handle);
      cron = DAILY_0600;
      schedule = { name: 'improver', kind: 'improve', cron: () => Promise.resolve(cron) };
    });
    afterEach(async () => {
      await t.destroy();
    });

    const schedulerAt = (now: Date, handle = t.handle) =>
      createScheduler({
        handle,
        queue: createJobQueue(handle),
        workspaceId: LOCAL_WORKSPACE_ID,
        schedules: [schedule],
        now: () => now,
      });
    const jobs = () => queue.list({ limit: 50 });

    it('does not fire a past period on the first start of a schedule without state', async () => {
      await schedulerAt(new Date('2026-11-09T09:00:00Z')).tick();
      await schedulerAt(new Date('2026-11-09T09:01:00Z')).tick();
      expect(await jobs()).toHaveLength(0);
      await schedulerAt(new Date('2026-11-10T06:00:30Z')).tick();
      expect(await jobs()).toHaveLength(1);
    });

    it('catches up on start with exactly one job after several missed nights', async () => {
      // The laptop slept through three 06:00 runs; only the latest period is enqueued.
      await schedulerAt(new Date('2026-11-05T09:00:00Z')).tick(); // first start: state only
      await schedulerAt(new Date('2026-11-09T09:00:00Z')).tick();
      const all = await jobs();
      expect(all).toHaveLength(1);
      expect(all[0]?.idempotencyKey).toMatch(/^schedule:.*:improver:/);
    });

    it('does not fire twice for the same period', async () => {
      await schedulerAt(new Date('2026-11-08T09:00:00Z')).tick();
      const s = schedulerAt(new Date('2026-11-09T09:00:00Z'));
      await s.tick();
      await s.tick();
      await schedulerAt(new Date('2026-11-09T23:59:00Z')).tick();
      expect(await jobs()).toHaveLength(1);
    });

    it('fires again when the next period is due', async () => {
      await schedulerAt(new Date('2026-11-08T09:00:00Z')).tick();
      await schedulerAt(new Date('2026-11-09T09:00:00Z')).tick();
      await schedulerAt(new Date('2026-11-10T06:00:30Z')).tick();
      expect(await jobs()).toHaveLength(2);
    });

    it('skips a manual schedule', async () => {
      cron = null;
      await schedulerAt(new Date('2026-11-09T09:00:00Z')).tick();
      expect(await jobs()).toHaveLength(0);
    });

    it('enqueues once when several replicas tick at the same moment', async () => {
      const now = new Date('2026-11-09T09:00:00Z');
      await schedulerAt(new Date('2026-11-08T09:00:00Z')).tick(); // first start: state only
      // better-sqlite3 blocks its thread while waiting for a lock, so two SQLite connections in one
      // process would deadlock; SQLite has one scheduler process anyway (ADR-0005).
      const connection = () => (t.dialect === 'postgres' ? t.open() : t.handle);
      const replicas = [t.handle, connection(), connection()].map((h) => schedulerAt(now, h));
      await Promise.all(replicas.map((r) => r.tick()));
      expect(await jobs()).toHaveLength(1);
    });
  });
}
