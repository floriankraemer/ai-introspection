import { Cron } from 'croner';
import { fromJson } from '../../platform/db/json.js';
import { InvalidInputError } from '../../platform/errors.js';
import { DeferJob, type JobHandler } from '../../platform/jobs/worker.js';
import type { Schedule } from '../../platform/jobs/scheduler.js';
import type { ImprovementDeps } from './context.js';
import { createProposals, type ProposalStatus } from './proposals.js';
import { createRunner, type RunSummary } from './runner.js';

export {
  createSkillRepos,
  detectSkillRepos,
  type DetectedSkillRepo,
  type SkillRepoDto,
  type SkillRepoRow,
  type SkillRepos,
  type SkillReposOptions,
} from './skill-repos.js';
export type { GhRunner, ImprovementDeps } from './context.js';
export { createImproverProvider, type ImproverProvider } from './improvers.js';
export { createFakeImprover } from './improver-fake.js';
export { createApiImprover } from './improver-api.js';
export { createCliImprover } from './improver-cli.js';
export { IMPROVER_MODEL, type Improver, type ImproveRequest, type ImproveResult } from './types.js';
export type { ClusterSummary, ProposalDto, ProposalList, ProposalStatus } from './proposals.js';
export type { RunResult, RunSummary } from './runner.js';
export { inspectDiff, DiffRejectedError } from './diff.js';

export const IMPROVER_RUN_JOB = 'improve';
const PR_SYNC_JOB = 'proposal_pr_sync';
/** Open pull requests are polled this often (ADR-0010). */
const PR_SYNC_CRON = '*/10 * * * *';
const DAY_MS = 86_400_000;
const CRONS = { daily: '0 6 * * *', weekly: '0 6 * * 1' } as const;
const RUNS_SHOWN = 20;

/** `24h`, `7d` or `2w` as a point in time that long ago. */
export function parseSince(text: string, now = new Date()): Date {
  const m = /^(\d+)([hdw])$/.exec(text);
  if (!m) throw new InvalidInputError('since takes a number and a unit: 24h, 7d or 2w');
  const unit = { h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS }[m[2] as 'h' | 'd' | 'w'];
  return new Date(now.getTime() - Number(m[1]) * unit);
}

export interface ImproverRunDto {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  clusters: number;
  proposalsCreated: number;
  /** Same as `proposalsCreated`. */
  proposals: number;
  /** Clusters that got no proposal (skipped, declined, failed, deferred). */
  clustersSkipped: number;
  untrustedRubrics: string[];
  error: string | null;
  summary: RunSummary | null;
}

export function createImprovement(deps: ImprovementDeps) {
  const now = deps.now ?? (() => new Date());
  const proposals = createProposals(deps);
  const runner = createRunner(deps);

  async function cronOf(): Promise<string | null> {
    const mode = (await deps.settings.get())['schedule.improver'];
    return mode === 'manual' ? null : CRONS[mode];
  }

  /** The look-back window of a scheduled run: the period since the previous one. */
  async function scheduledSince(): Promise<Date> {
    const mode = (await deps.settings.get())['schedule.improver'];
    return new Date(now().getTime() - (mode === 'weekly' ? 7 : 1) * DAY_MS);
  }

  /** Runs the improver; a budget stop defers the job, so the next window picks it up. */
  async function runAndDefer(since: Date): Promise<void> {
    const result = await runner.run(since);
    if (result.deferUntil)
      throw new DeferJob(result.deferUntil, result.deferReason ?? 'the budget is used up');
  }

  const handlers: Record<string, JobHandler> = {
    [IMPROVER_RUN_JOB]: {
      concurrency: 1,
      run: async (job) => {
        const p = (job.payload ?? {}) as { since?: string };
        await runAndDefer(p.since ? new Date(p.since) : await scheduledSince());
      },
    },
    [PR_SYNC_JOB]: {
      concurrency: 1,
      run: async () => {
        await proposals.syncPullRequests();
      },
    },
  };

  const schedules: Schedule[] = [
    { name: 'improver', cron: cronOf, kind: IMPROVER_RUN_JOB },
    { name: 'proposal-pr-sync', cron: () => Promise.resolve(PR_SYNC_CRON), kind: PR_SYNC_JOB },
  ];

  return {
    handlers,
    schedules,
    proposals,

    /** `introspect improve --now`: in the foreground. */
    run: (since: Date) => runner.run(since),

    /** Queues a manual run; returns the job id. */
    async enqueueRun(since?: string): Promise<string> {
      const id = await deps.queue.enqueue({
        workspaceId: deps.workspaceId,
        kind: IMPROVER_RUN_JOB,
        payload: {
          since: (since ? parseSince(since, now()) : await scheduledSince()).toISOString(),
        },
        maxAttempts: 3,
      });
      if (!id) throw new Error('The improver job was not created');
      return id;
    },

    async schedule(): Promise<{ mode: 'daily' | 'weekly' | 'manual'; nextRunAt: string | null }> {
      const mode = (await deps.settings.get())['schedule.improver'];
      return {
        mode,
        nextRunAt:
          mode === 'manual' ? null : (new Cron(CRONS[mode]).nextRun(now())?.toISOString() ?? null),
      };
    },

    async runs(): Promise<ImproverRunDto[]> {
      const rows = await deps.db
        .selectFrom('improver_run')
        .selectAll()
        .where('workspace_id', '=', deps.workspaceId)
        .orderBy('started_at', 'desc')
        .orderBy('id', 'desc')
        .limit(RUNS_SHOWN)
        .execute();
      return rows.map((r) => {
        const summary = r.summary === null ? null : (fromJson(r.summary) as RunSummary);
        return {
          id: r.id,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          status: r.status,
          clusters: r.clusters,
          proposalsCreated: r.proposals_created,
          proposals: r.proposals_created,
          clustersSkipped: summary?.clusters.filter((c) => c.outcome !== 'proposed').length ?? 0,
          untrustedRubrics: summary?.untrustedExcluded.map((u) => u.rubric) ?? [],
          error: r.error,
          summary,
        };
      });
    },
  };
}

export type Improvement = ReturnType<typeof createImprovement>;
export type { ProposalStatus as ProposalStatusFilter };
