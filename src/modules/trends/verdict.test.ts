import { describe, expect, it } from 'vitest';
import { overallVerdict, pValueOf, rubricVerdicts } from './verdict.js';

const t = (passed: number, graded: number) => ({ passed, graded });
const one = (before: ReturnType<typeof t>, after: ReturnType<typeof t>, min = 10) =>
  rubricVerdicts([{ rubric: 'r', before, after }], min)[0];

describe('rubricVerdicts (one rubric, distinct sessions)', () => {
  it('is too early when EITHER side is below the minimum, whatever the rates', () => {
    expect(one(t(1, 20), t(9, 9))?.verdict).toBe('too_early');
    expect(one(t(0, 3), t(10, 10))?.verdict).toBe('too_early');
    expect(one(t(0, 0), t(10, 10))?.verdict).toBe('too_early');
    expect(one(t(0, 3), t(10, 10))?.pValue).toBeNull();
  });

  it('does not call 7/10 against 10/10 a change (the old pooled z-test did)', () => {
    const v = one(t(7, 10), t(10, 10));
    expect(v?.verdict).toBe('no_change');
    expect(v?.pValue).toBeCloseTo(0.2105, 3);
  });

  it('uses Fisher for small samples: 3/10 to 8/10 is significant at 10%, 4/10 to 8/10 is not', () => {
    expect(one(t(3, 10), t(8, 10))?.verdict).toBe('improved');
    expect(one(t(3, 10), t(8, 10))?.pValue).toBeCloseTo(0.0698, 3);
    expect(one(t(4, 10), t(8, 10))?.verdict).toBe('no_change');
    expect(one(t(8, 10), t(3, 10))?.verdict).toBe('worse');
  });

  it('uses the z-test from 30 sessions per side on', () => {
    expect(one(t(10, 40), t(30, 40))?.verdict).toBe('improved');
    expect(one(t(30, 40), t(10, 40))?.verdict).toBe('worse');
    expect(pValueOf(t(15, 30), t(15, 30))).toBeCloseTo(1, 5);
    // 15/30 against 21/30: z = 1.58, p = 0.114
    expect(pValueOf(t(15, 30), t(21, 30))).toBeCloseTo(0.114, 2);
  });

  it('has no variance when every session passed (or failed) on both sides', () => {
    expect(one(t(10, 10), t(12, 12))?.verdict).toBe('no_change');
    expect(one(t(0, 10), t(0, 12))?.verdict).toBe('no_change');
    expect(one(t(40, 40), t(40, 40))?.pValue).toBe(1);
  });

  it('honours the configured minimum', () => {
    expect(one(t(1, 5), t(5, 5), 5)?.verdict).toBe('improved');
    expect(one(t(1, 5), t(5, 5), 6)?.verdict).toBe('too_early');
  });
});

describe('Holm correction over rubrics', () => {
  const rubrics = (...pairs: [string, ReturnType<typeof t>, ReturnType<typeof t>][]) =>
    rubricVerdicts(
      pairs.map(([rubric, before, after]) => ({ rubric, before, after })),
      10,
    );

  it('does not inflate: 0.07 alone is a win, among two rubrics it is not (0.07 > 0.10 / 2)', () => {
    const alone = rubrics(['a', t(3, 10), t(8, 10)]);
    expect(overallVerdict(alone)).toBe('improved');
    const two = rubrics(['a', t(3, 10), t(8, 10)], ['b', t(5, 10), t(5, 10)]);
    expect(two.map((r) => r.verdict)).toEqual(['no_change', 'no_change']);
    expect(overallVerdict(two)).toBe('no_change');
  });

  it('still finds a clear win among several rubrics (smallest p against 0.10 / m)', () => {
    const list = rubrics(
      ['a', t(1, 12), t(11, 12)], // p = 0.0001
      ['b', t(5, 10), t(5, 10)],
      ['c', t(5, 10), t(6, 10)],
    );
    expect(list.map((r) => r.verdict)).toEqual(['improved', 'no_change', 'no_change']);
    expect(overallVerdict(list)).toBe('improved');
  });

  it('is worse when any rubric is significantly worse, even next to an improvement', () => {
    const list = rubrics(['a', t(1, 12), t(11, 12)], ['b', t(11, 12), t(1, 12)]);
    expect(overallVerdict(list)).toBe('worse');
  });

  it('ignores rubrics below the gate when counting for Holm, and is too early when none passes it', () => {
    const list = rubrics(['a', t(3, 10), t(8, 10)], ['b', t(0, 2), t(2, 2)]);
    expect(list.map((r) => r.verdict)).toEqual(['improved', 'too_early']);
    expect(overallVerdict(rubrics(['a', t(0, 2), t(2, 2)]))).toBe('too_early');
    expect(overallVerdict([])).toBe('too_early');
  });
});
