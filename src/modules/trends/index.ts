import type { createGrading } from '../grading/index.js';
import type { createIngest } from '../ingest/index.js';

const DAY_MS = 86_400_000;

export interface TrendSummary {
  days: number;
  sessionsCollected: number;
  sessionsGraded: number;
  rubrics: { name: string; passRate: number | null; target: number; gradedCount: number }[];
}

/** Header counts and pass-rate cards of the Sessions screen. */
export function createTrends(
  ingest: Pick<ReturnType<typeof createIngest>, 'sessions'>,
  grading: Pick<ReturnType<typeof createGrading>, 'trendRubrics'>,
) {
  return {
    async summary(days: number, now = new Date()): Promise<TrendSummary> {
      const since = new Date(now.getTime() - days * DAY_MS);
      const sessionsCollected = await ingest.sessions.countStartedSince(since);
      const { sessionsGraded, rubrics } = await grading.trendRubrics(since);
      return { days, sessionsCollected, sessionsGraded, rubrics };
    },
  };
}
