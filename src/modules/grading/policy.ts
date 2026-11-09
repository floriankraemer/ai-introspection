import type { GradeCandidate } from '../ingest/index.js';
import type { Settings } from '../settings/index.js';

export type GradePolicySettings = Pick<Settings, 'judge.sampling' | 'schedule.grade'>;

/**
 * The cheap-before-smart gate (build plan): an ended session is graded when it was flagged by the
 * signals or fell into the 20 % sample, or always when sampling is `every`. With the `pr_merge`
 * trigger a session also needs a merged pull request.
 */
export function shouldGrade(c: GradeCandidate, s: GradePolicySettings): boolean {
  if (c.status !== 'ended') return false;
  if (s['schedule.grade'] === 'pr_merge' && c.outcomeKind !== 'pr_merged') return false;
  return s['judge.sampling'] === 'every' || c.flagged || c.sampled;
}

/**
 * `applies_to` in a rubric file is a sentence for people. Two phrases have a meaning here;
 * anything else (including `all`) applies to every session.
 */
export function appliesTo(text: string, c: GradeCandidate): boolean {
  const t = text.toLowerCase();
  if (t.includes('failed tool')) return c.failedToolCalls > 0;
  if (t.includes('tests')) return c.testsRun > 0;
  return true;
}
