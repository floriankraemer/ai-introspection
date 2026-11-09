export type ChangeVerdict = 'improved' | 'worse' | 'no_change' | 'too_early';

export interface Tally {
  graded: number;
  passed: number;
}

/** Two-sided significance level of every test. */
export const ALPHA = 0.1;
/** Below this many sessions on either side the normal approximation is not trusted: Fisher's exact test is used. */
const FISHER_BELOW = 30;

export interface RubricComparison {
  rubric: string;
  before: Tally;
  after: Tally;
}

export interface RubricVerdict extends RubricComparison {
  verdict: ChangeVerdict;
  /** Two-sided p-value; null when the sample gate was not met. */
  pValue: number | null;
}

const logFactorials: number[] = [0];
function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i += 1)
    logFactorials.push((logFactorials[i - 1] ?? 0) + Math.log(i));
  return logFactorials[n] ?? 0;
}

/** Two-sided Fisher exact test on [[a, b], [c, d]]: the summed probability of every table as or less likely than the observed one. */
function fisherTwoSided(a: number, b: number, c: number, d: number): number {
  const row1 = a + b;
  const col1 = a + c;
  const n = a + b + c + d;
  const logP = (x: number): number =>
    logFactorial(row1) +
    logFactorial(n - row1) +
    logFactorial(col1) +
    logFactorial(n - col1) -
    logFactorial(n) -
    logFactorial(x) -
    logFactorial(row1 - x) -
    logFactorial(col1 - x) -
    logFactorial(n - row1 - col1 + x);
  const observed = logP(a);
  let p = 0;
  for (let x = Math.max(0, row1 + col1 - n); x <= Math.min(row1, col1); x += 1) {
    const lp = logP(x);
    if (lp <= observed + 1e-9) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/** Complementary error function (Abramowitz and Stegun 7.1.26, absolute error below 1.5e-7). */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-x * x);
}

/** Two-sided pooled two-proportion z-test. */
function zTwoSided(before: Tally, after: Tally): number {
  const pooled = (before.passed + after.passed) / (before.graded + after.graded);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / before.graded + 1 / after.graded));
  if (se === 0) return 1; // everything passed (or failed) on both sides: nothing differs
  const z = (after.passed / after.graded - before.passed / before.graded) / se;
  return erfc(Math.abs(z) / Math.SQRT2);
}

/**
 * The p-value of one rubric's before/after comparison over distinct sessions: Fisher's exact test
 * when either side has fewer than 30 sessions, the pooled z-test otherwise.
 */
export function pValueOf(before: Tally, after: Tally): number {
  if (before.graded < FISHER_BELOW || after.graded < FISHER_BELOW)
    return fisherTwoSided(
      after.passed,
      after.graded - after.passed,
      before.passed,
      before.graded - before.passed,
    );
  return zTwoSided(before, after);
}

const rateOf = (t: Tally): number => t.passed / t.graded;

/**
 * The verdict of each rubric, then the Holm step-down correction over the rubrics that met the
 * sample gate (`minGraded` distinct sessions on BOTH sides, else `too_early`): the smallest
 * p-value must be at most ALPHA / m, the next ALPHA / (m - 1), and so on, until one fails.
 * A rubric that survives is `improved` or `worse` by the direction of its rates, the others `no_change`.
 *
 * ponytail: the ceiling is statistical power, not the formula. At 10 sessions per side only a
 * gap of 40 to 50 points (6/10 against 10/10, or 3/10 against 8/10) reaches 90%, Fisher's test being
 * more conservative than a z-test, and Holm costs another step with several rubrics. Sessions are not
 * paired and their mix is not adjusted. Upgrade path: raise `trends.min_graded` or
 * `trends.window_days`, or switch to a sequential test.
 */
export function rubricVerdicts(
  comparisons: readonly RubricComparison[],
  minGraded: number,
): RubricVerdict[] {
  const gated = comparisons.map((c) => c.before.graded >= minGraded && c.after.graded >= minGraded);
  const out: RubricVerdict[] = comparisons.map((c, i) => ({
    ...c,
    verdict: gated[i] ? 'no_change' : 'too_early',
    pValue: gated[i] ? pValueOf(c.before, c.after) : null,
  }));
  const ranked = out
    .filter((v) => v.pValue !== null)
    .sort((a, b) => (a.pValue ?? 1) - (b.pValue ?? 1));
  for (const [i, v] of ranked.entries()) {
    if ((v.pValue ?? 1) > ALPHA / (ranked.length - i)) break;
    v.verdict = rateOf(v.after) > rateOf(v.before) ? 'improved' : 'worse';
  }
  return out;
}

/** Worse if any rubric got worse, else improved if any improved, else no change; too early when no rubric had enough sessions. */
export function overallVerdict(list: readonly Pick<RubricVerdict, 'verdict'>[]): ChangeVerdict {
  const has = (v: ChangeVerdict): boolean => list.some((r) => r.verdict === v);
  if (has('worse')) return 'worse';
  if (has('improved')) return 'improved';
  return has('no_change') ? 'no_change' : 'too_early';
}

/** The rubric to show at the top level of a change: the smallest p-value; with none, the one with most sessions after. */
export function headline(list: readonly RubricVerdict[]): RubricVerdict | undefined {
  return [...list].sort(
    (a, b) => (a.pValue ?? 2) - (b.pValue ?? 2) || b.after.graded - a.after.graded,
  )[0];
}
