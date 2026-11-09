import { Cron } from 'croner';
import { sql } from 'kysely';
import type { DbHandle } from '../db/connection.js';
import type { JobQueue } from './queue.js';

export interface Schedule {
  /** Stable name; also the key of the persisted `schedule_state` row. */
  name: string;
  /** Resolved on every tick so Settings changes apply without restart; `null` means manual only. */
  cron(): Promise<string | null>;
  kind: string;
  payload?: unknown;
}

export interface SchedulerOptions {
  handle: DbHandle;
  queue: JobQueue;
  workspaceId: string;
  schedules: readonly Schedule[];
  intervalMs?: number;
  now?: () => Date;
}

export interface Scheduler {
  /** Runs immediately (catch-up after sleep or downtime), then every `intervalMs`. */
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

// Arbitrary constant naming the scheduler lock inside Postgres.
const ADVISORY_LOCK_KEY = 7_317_001;

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const {
    handle,
    queue,
    workspaceId,
    schedules,
    intervalMs = 60_000,
    now = () => new Date(),
  } = opts;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  async function fire(schedule: Schedule, period: string): Promise<void> {
    await handle.db.transaction().execute(async (tx) => {
      if (handle.dialect === 'postgres') {
        // Transaction-scoped, so the lock cannot leak with a pooled connection; other replicas skip this tick.
        const { rows } = await sql<{
          locked: boolean;
        }>`select pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) as locked`.execute(tx);
        if (!rows[0]?.locked) return;
      }
      const state = await tx
        .selectFrom('schedule_state')
        .select('last_fired_period')
        .where('workspace_id', '=', workspaceId)
        .where('name', '=', schedule.name)
        .executeTakeFirst();
      if (state && state.last_fired_period >= period) return;
      // The key makes a lost schedule_state row harmless: the period is enqueued once.
      await queue.enqueue(
        {
          workspaceId,
          kind: schedule.kind,
          payload: schedule.payload,
          idempotencyKey: `schedule:${workspaceId}:${schedule.name}:${period}`,
        },
        tx,
      );
      await tx
        .insertInto('schedule_state')
        .values({ workspace_id: workspaceId, name: schedule.name, last_fired_period: period })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'name']).doUpdateSet({ last_fired_period: period }),
        )
        .execute();
    });
  }

  async function tick(): Promise<void> {
    const at = now();
    for (const schedule of schedules) {
      const pattern = await schedule.cron();
      if (!pattern) continue;
      // Only the latest due period fires: several missed nights collapse into one job (ADR-0005).
      const [latest] = new Cron(pattern, { paused: true }).previousRuns(1, at);
      if (latest) await fire(schedule, latest.toISOString());
    }
  }

  return {
    start() {
      const run = (): void => {
        tick()
          .catch((e: unknown) => {
            console.error('scheduler tick failed', e);
          })
          .finally(() => {
            if (!stopped) timer = setTimeout(run, intervalMs);
          });
      };
      run();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
    tick,
  };
}
