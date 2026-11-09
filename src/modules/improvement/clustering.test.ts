import { describe, expect, it } from 'vitest';
import { clusterFailures, type TargetedFailure } from './clustering.js';

const f = (
  sessionId: string,
  reason: string,
  rubric = 'efficiency',
  repo = 'r1',
): TargetedFailure => ({
  sessionId,
  rubric,
  rubricSha: 'sha',
  reason,
  evidenceEventIds: [],
  gradedAt: '2026-11-09T00:00:00Z',
  sessionTitle: sessionId,
  repoRoot: null,
  cwd: null,
  targetRepoId: repo,
});

describe('clusterFailures', () => {
  it('groups similar reasons of one rubric and target, ranked by session count', () => {
    const out = clusterFailures([
      f('a', 'Ran pnpm test repeatedly after the same failing test'),
      f('b', 'Repeated pnpm test runs of the same failing test'),
      f('c', 'Wrote a long summary nobody asked for'),
    ]);
    expect(out.map((c) => c.sessionIds)).toEqual([['a', 'b'], ['c']]);
    expect(out[0]?.terms).toContain('pnpm');
    expect(out[0]?.summary).toMatch(/^efficiency: 2 sessions failing/);
  });
  it('never mixes rubrics or target repositories', () => {
    const out = clusterFailures([
      f('a', 'same words here', 'efficiency', 'r1'),
      f('b', 'same words here', 'verbosity', 'r1'),
      f('c', 'same words here', 'efficiency', 'r2'),
    ]);
    expect(out).toHaveLength(3);
  });
  it('is deterministic', () => {
    const input = [f('b', 'alpha beta gamma'), f('a', 'alpha beta delta')];
    expect(clusterFailures(input)).toEqual(clusterFailures([...input].reverse()).map((c) => c));
  });
});
