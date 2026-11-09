export type ChangeVerdict = 'improved' | 'worse' | 'no_change' | 'too_early';

export interface Tally {
  graded: number;
  passed: number;
}

/** Two-sided 90% critical value of the standard normal distribution. */
const Z_90 = 1.6449;

/**
 * The verdict of a before/after comparison: a pooled two-proportion z-test at 90% confidence.
 *
 * - `too_early` while fewer than `minGraded` sessions were graded after the change, or none before it.
 * - `improved` / `worse` when the difference is significant, `no_change` otherwise.
 *
 * ponytail: the ceiling is statistical power, not the formula. With the default 10 sessions on
 * each side only a gap of about 35 points reaches 90%, so small real gains read as `no_change`.
 * It also compares rates, not sessions (no pairing, no adjustment for session mix). Upgrade path:
 * raise `trends.min_graded` or `trends.window_days`, or switch to a sequential test.
 */
export function verdictOf(before: Tally, after: Tally, minGraded: number): ChangeVerdict {
  if (after.graded < minGraded || before.graded === 0) return 'too_early';
  const p1 = before.passed / before.graded;
  const p2 = after.passed / after.graded;
  const pooled = (before.passed + after.passed) / (before.graded + after.graded);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / before.graded + 1 / after.graded));
  // No variance (everything passed, or everything failed, on both sides): nothing differs.
  if (se === 0) return 'no_change';
  const z = (p2 - p1) / se;
  if (z >= Z_90) return 'improved';
  if (z <= -Z_90) return 'worse';
  return 'no_change';
}
