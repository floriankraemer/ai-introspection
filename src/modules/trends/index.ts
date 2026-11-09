import type { createIngest } from '../ingest/index.js';

const DAY_MS = 86_400_000;

export interface TrendSummary {
  days: number;
  sessionsCollected: number;
  sessionsGraded: number;
  rubrics: { name: string; passRate: number | null; target: number; gradedCount: number }[];
}

/** Header counts of the Sessions screen. Grading arrives in Phase 2, so nothing is graded and no rubric reports a rate yet. */
export function createTrends(ingest: Pick<ReturnType<typeof createIngest>, 'sessions'>) {
  return {
    async summary(days: number, now = new Date()): Promise<TrendSummary> {
      const sessionsCollected = await ingest.sessions.countStartedSince(
        new Date(now.getTime() - days * DAY_MS),
      );
      return { days, sessionsCollected, sessionsGraded: 0, rubrics: [] };
    },
  };
}
