import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_WORKSPACE_ID } from '../identity/index.js';
import { backoffMs, createJobQueue, LEASE_MS, type JobQueue } from '../jobs/queue.js';
import { createWorker, DeferJob } from '../jobs/worker.js';
import type { TestDb, TestDbFactory } from './db.js';

const ws = LOCAL_WORKSPACE_ID;
const T0 = new Date('2026-11-09T10:00:00.000Z');
const later = (ms: number): Date => new Date(T0.getTime() + ms);

export function jobsSuite(name: string, make: TestDbFactory): void {
  describe(`job queue and worker (${name})`, () => {
    let t: TestDb;
    let queue: JobQueue;
    beforeEach(async () => {
      t = await make();
      queue = createJobQueue(t.handle);
    });
    afterEach(async () => {
      await t.destroy();
    });

    const enqueue = (kind = 'k', extra: Partial<Parameters<JobQueue['enqueue']>[0]> = {}) =>
      queue.enqueue({ workspaceId: ws, kind, runAfter: T0, ...extra });

    it('ignores a second enqueue with the same idempotency key', async () => {
      expect(await enqueue('k', { idempotencyKey: 'grade:s1:v1:m' })).not.toBeNull();
      expect(await enqueue('k', { idempotencyKey: 'grade:s1:v1:m' })).toBeNull();
      expect(await queue.list({ limit: 10 })).toHaveLength(1);
    });

    it('rolls back the job together with the caller transaction', async () => {
      await expect(
        t.handle.db.transaction().execute(async (tx) => {
          await queue.enqueue({ workspaceId: ws, kind: 'k' }, tx);
          throw new Error('state change failed');
        }),
      ).rejects.toThrow('state change failed');
      expect(await queue.list({ limit: 10 })).toHaveLength(0);
    });

    it('claims by priority, then age, and only runnable jobs of the asked kinds', async () => {
      const low = await enqueue('a');
      const high = await enqueue('a', { priority: 5 });
      await enqueue('a', { runAfter: later(60_000) });
      await enqueue('other');
      expect((await queue.claim('w', ['a'], T0))?.id).toBe(high);
      expect((await queue.claim('w', ['a'], T0))?.id).toBe(low);
      expect(await queue.claim('w', ['a'], T0)).toBeNull();
    });

    it('never hands the same job to two claimers racing on separate connections', async () => {
      const others = [createJobQueue(t.open()), createJobQueue(t.open()), createJobQueue(t.open())];
      const total = 40;
      for (let i = 0; i < total; i++) await enqueue();
      const claimers = [queue, ...others, queue, ...others, queue];
      const claimed = (
        await Promise.all(
          claimers.map(async (q, i) => {
            const ids: string[] = [];
            for (let n = 0; n < total; n++) {
              const job = await q.claim(`w${String(i)}`, ['k'], T0);
              if (job) ids.push(job.id);
            }
            return ids;
          }),
        )
      ).flat();
      expect(claimed).toHaveLength(total);
      expect(new Set(claimed).size).toBe(total);
      // A claim that also updated a second row would leave a running job nobody holds.
      const all = await queue.list({ limit: 100 });
      expect(all.filter((j) => j.status === 'running')).toHaveLength(total);
      expect(all.every((j) => j.attempts === 1)).toBe(true);
    });

    it('returns a job with an expired lease to the queue and runs it again', async () => {
      const id = await enqueue();
      await queue.claim('dead-worker', ['k'], T0);
      expect(await queue.reapExpired(later(LEASE_MS - 1))).toBe(0);
      expect(await queue.reapExpired(later(LEASE_MS + 1))).toBe(1);
      const again = await queue.claim('w2', ['k'], later(LEASE_MS + 1));
      expect(again).toMatchObject({ id, attempts: 2, lockedBy: 'w2' });
    });

    it('extends the lease on heartbeat only for the owner', async () => {
      await enqueue();
      const job = await queue.claim('w1', ['k'], T0);
      expect(await queue.heartbeat(job?.id ?? '', 'intruder', later(1000))).toBe(false);
      expect(await queue.heartbeat(job?.id ?? '', 'w1', later(LEASE_MS))).toBe(true);
      expect(await queue.reapExpired(later(LEASE_MS + 1))).toBe(0);
    });

    it('retries with exponential backoff and gives up as dead after max attempts', async () => {
      const id = (await enqueue('k', { maxAttempts: 3 })) ?? '';
      let now = T0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const job = await queue.claim('w', ['k'], now);
        expect(job?.attempts).toBe(attempt);
        const status = await queue.fail(id, 'w', `boom ${String(attempt)}`, now);
        expect(status).toBe(attempt < 3 ? 'failed' : 'dead');
        if (attempt < 3) {
          const failed = await queue.get(id);
          expect(failed?.runAfter).toBe(new Date(now.getTime() + backoffMs(attempt)).toISOString());
          expect(
            await queue.claim('w', ['k'], new Date(now.getTime() + backoffMs(attempt) - 1)),
          ).toBeNull();
          now = new Date(now.getTime() + backoffMs(attempt));
        }
      }
      expect(await queue.get(id)).toMatchObject({ status: 'dead', lastError: 'boom 3' });
      expect(await queue.claim('w', ['k'], later(10 ** 9))).toBeNull();
      expect(await queue.retryDead(id, later(10 ** 9))).toBe(true);
      expect(await queue.claim('w', ['k'], later(10 ** 9))).toMatchObject({ id, attempts: 1 });
    });

    it('marks an out-of-attempts job with an expired lease dead instead of looping', async () => {
      const id = (await enqueue('k', { maxAttempts: 1 })) ?? '';
      await queue.claim('w', ['k'], T0);
      await queue.reapExpired(later(LEASE_MS + 1));
      expect((await queue.get(id))?.status).toBe('dead');
    });

    it('paginates newest first with a cursor', async () => {
      for (let i = 0; i < 3; i++) await enqueue('k');
      const first = await queue.list({ limit: 2 });
      const rest = await queue.list({ limit: 2, cursor: first[1]?.id ?? '' });
      expect(first).toHaveLength(2);
      expect(rest).toHaveLength(1);
      expect(new Set([...first, ...rest].map((j) => j.id)).size).toBe(3);
    });

    describe('worker', () => {
      it('runs handlers, respects per-kind concurrency and records success', async () => {
        for (let i = 0; i < 4; i++) await enqueue('grade');
        let active = 0;
        let peak = 0;
        const worker = createWorker({
          queue,
          now: () => T0,
          handlers: {
            grade: {
              concurrency: 2,
              run: async () => {
                active++;
                peak = Math.max(peak, active);
                await new Promise((r) => setTimeout(r, 20));
                active--;
              },
            },
          },
        });
        await worker.tick();
        expect(peak).toBe(2);
        await worker.tick();
        const jobs = await queue.list({ limit: 10 });
        expect(jobs.map((j) => j.status)).toEqual([
          'succeeded',
          'succeeded',
          'succeeded',
          'succeeded',
        ]);
      });

      it('retries a failing handler after its backoff and then succeeds', async () => {
        const id = (await enqueue('flaky')) ?? '';
        let calls = 0;
        let now = T0;
        const worker = createWorker({
          queue,
          now: () => now,
          onError: () => undefined,
          handlers: {
            flaky: {
              concurrency: 1,
              run: () => {
                calls++;
                return calls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve();
              },
            },
          },
        });
        await worker.tick();
        expect((await queue.get(id))?.status).toBe('failed');
        await worker.tick();
        expect(calls).toBe(1); // still backing off
        now = later(backoffMs(1));
        await worker.tick();
        expect(await queue.get(id)).toMatchObject({ status: 'succeeded', attempts: 2 });
      });

      it('defers without consuming an attempt when the handler asks to wait', async () => {
        const id = (await enqueue('llm')) ?? '';
        const worker = createWorker({
          queue,
          now: () => T0,
          onError: () => undefined,
          handlers: {
            llm: {
              concurrency: 1,
              run: () => Promise.reject(new DeferJob(later(3_600_000), 'budget')),
            },
          },
        });
        await worker.tick();
        expect(await queue.get(id)).toMatchObject({
          status: 'deferred',
          attempts: 0,
          runAfter: later(3_600_000).toISOString(),
        });
      });

      it('stop() waits for running jobs', async () => {
        await enqueue('slow', { runAfter: new Date(0) });
        let finished = false;
        const worker = createWorker({
          queue,
          pollMs: 5,
          handlers: {
            slow: {
              concurrency: 1,
              run: async () => {
                await new Promise((r) => setTimeout(r, 50));
                finished = true;
              },
            },
          },
        });
        worker.start();
        await vi.waitFor(async () => {
          expect((await queue.list({ status: 'running', limit: 1 })).length).toBe(1);
        });
        await worker.stop();
        expect(finished).toBe(true);
      });
    });
  });
}
