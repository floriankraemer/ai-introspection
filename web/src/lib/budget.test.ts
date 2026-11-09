import { describe, expect, it } from 'vitest';
import type { Budget } from '../api/types.js';
import { estimateGrading, exhaustedUntil } from './budget.js';

const base: Budget = {
  mode: 'tokens_day',
  tokensToday: 0,
  tokensPerDay: 3_000_000,
  usdMonth: 0,
  usdPerMonth: null,
  improver: { tokensToday: 0, usdMonth: 0 },
  deferredJobs: 0,
  tokensResetAt: '2030-01-02T00:00:00Z',
  usdResetAt: '2030-02-01T00:00:00Z',
};

describe('estimateGrading', () => {
  it('counts sessions x rubrics and how many sessions fit', () => {
    const e = estimateGrading(base, 50, 4);
    expect(e).toEqual({ needed: 12_000_000, left: 3_000_000, fits: 12, over: true });
  });
  it('is never over without a limit', () => {
    expect(estimateGrading({ ...base, tokensPerDay: null }, 50, 4).over).toBe(false);
  });
});

describe('exhaustedUntil', () => {
  it('is null while budget is left, the reset time once used up', () => {
    expect(exhaustedUntil(base)).toBeNull();
    expect(exhaustedUntil({ ...base, tokensToday: 3_000_000 })).toBe(base.tokensResetAt);
    expect(exhaustedUntil({ ...base, tokensPerDay: null, usdPerMonth: 5, usdMonth: 5 })).toBe(
      base.usdResetAt,
    );
  });
});
