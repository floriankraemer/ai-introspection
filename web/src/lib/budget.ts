import type { Budget } from '../api/types.js';

/**
 * Tokens one session x rubric grade costs, for the pre-grading estimate.
 * The server prices each call from the condensed transcript length (src/modules/grading/budget.ts)
 * and no API exposes a per-grade figure, so this is a fixed rough average.
 */
export const TOKENS_PER_GRADE = 60_000;

/** The daily token limit; null when unlimited. Only the token window is estimated here. */
export function tokensLeft(b: Budget): number | null {
  return b.tokensPerDay === null ? null : Math.max(0, b.tokensPerDay - b.tokensToday);
}

export interface GradeEstimate {
  needed: number;
  /** Null when there is no daily token limit. */
  left: number | null;
  /** Whole sessions that fit in what is left (all rubrics each). */
  fits: number;
  /** True when the estimate is over what is left. */
  over: boolean;
}

export function estimateGrading(b: Budget, sessions: number, rubrics: number): GradeEstimate {
  const perSession = TOKENS_PER_GRADE * Math.max(1, rubrics);
  const left = tokensLeft(b);
  return {
    needed: sessions * perSession,
    left,
    fits: left === null ? sessions : Math.min(sessions, Math.floor(left / perSession)),
    over: left !== null && sessions * perSession > left,
  };
}

/** When the exhausted limit resets, or null while there is budget left. */
export function exhaustedUntil(b: Budget): string | null {
  if (b.tokensPerDay !== null && b.tokensToday >= b.tokensPerDay) return b.tokensResetAt;
  if (b.usdPerMonth !== null && b.usdMonth >= b.usdPerMonth) return b.usdResetAt;
  return null;
}
