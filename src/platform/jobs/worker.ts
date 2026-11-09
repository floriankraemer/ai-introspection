import { randomUUID } from 'node:crypto';
import type { Job, JobQueue } from './queue.js';

/** Throw from a handler to wait for a budget window; the attempt is not counted (ADR-0005). */
export class DeferJob extends Error {
  constructor(
    readonly runAfter: Date,
    reason: string,
  ) {
    super(reason);
    this.name = 'DeferJob';
  }
}

export interface JobHandler {
  /** Parallel jobs of this kind in this process (ADR-0005 defaults: ingest 1, grade 2, improve 1, link-outcome 2). */
  concurrency: number;
  run(job: Job): Promise<void>;
}

export interface WorkerOptions {
  queue: JobQueue;
  handlers: Readonly<Record<string, JobHandler>>;
  pollMs?: number;
  heartbeatMs?: number;
  now?: () => Date;
  onError?: (error: unknown, job: Job) => void;
}

export interface Worker {
  start(): void;
  /** Stops polling and waits for running jobs to finish. */
  stop(): Promise<void>;
  /** One claim pass; exposed for tests and for `introspect import`-style foreground runs. Resolves when the claimed jobs finish. */
  tick(): Promise<void>;
}

export function createWorker(opts: WorkerOptions): Worker {
  const { queue, handlers, pollMs = 1000, heartbeatMs = 60_000, now = () => new Date() } = opts;
  const workerId = `${String(process.pid)}:${randomUUID()}`;
  const running = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;

  async function execute(job: Job, handler: JobHandler): Promise<void> {
    const beat = setInterval(() => {
      queue.heartbeat(job.id, workerId, now()).catch((e: unknown) => opts.onError?.(e, job));
    }, heartbeatMs);
    try {
      await handler.run(job);
      await queue.complete(job.id, workerId, now());
    } catch (error) {
      if (error instanceof DeferJob)
        await queue.defer(job.id, workerId, error.runAfter, error.message);
      else
        await queue.fail(
          job.id,
          workerId,
          error instanceof Error ? error.message : String(error),
          now(),
        );
      opts.onError?.(error, job);
    } finally {
      clearInterval(beat);
    }
  }

  async function claimFor(kind: string, handler: JobHandler): Promise<void> {
    while ((running.get(kind) ?? 0) < handler.concurrency && !stopping) {
      const job = await queue.claim(workerId, [kind], now());
      if (!job) return;
      running.set(kind, (running.get(kind) ?? 0) + 1);
      const p = execute(job, handler)
        .catch((e: unknown) => opts.onError?.(e, job))
        .finally(() => {
          running.set(kind, (running.get(kind) ?? 1) - 1);
          inFlight.delete(p);
        });
      inFlight.add(p);
    }
  }

  async function pass(): Promise<void> {
    await queue.reapExpired(now());
    for (const [kind, handler] of Object.entries(handlers)) await claimFor(kind, handler);
  }

  async function tick(): Promise<void> {
    await pass();
    await Promise.all(inFlight);
  }

  let current: Promise<void> = Promise.resolve();

  return {
    start() {
      const loop = (): void => {
        // Claim without awaiting job completion so one slow job does not stall polling.
        current = pass()
          .catch((e: unknown) => {
            console.error('job worker pass failed', e);
          })
          .finally(() => {
            if (!stopping) timer = setTimeout(loop, pollMs);
          });
      };
      loop();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await current;
      await Promise.all(inFlight);
    },
    tick,
  };
}
