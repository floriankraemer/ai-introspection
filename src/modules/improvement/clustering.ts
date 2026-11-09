import { createHash } from 'node:crypto';
import type { FailedGrade } from '../grading/index.js';

export interface TargetedFailure extends FailedGrade {
  targetRepoId: string;
}

export interface Cluster {
  id: string;
  targetRepoId: string;
  rubric: string;
  failures: TargetedFailure[];
  sessionIds: string[];
  /** The most frequent words of the reasons: what the cluster is about. */
  terms: string[];
  summary: string;
}

/** Same-rubric reasons share at least this share of their words to land in one cluster. */
const SIMILARITY = 0.25;
const TOP_TERMS = 5;
const STOPWORDS = new Set(
  'the and for that this with was were has have had not but are from its into then than there their they them when which while after before been being does did doing also only just over under more most some such very can could would should will may might out off any all each both few other about again once here what who why how his her she him our your you one two use used using session agent assistant user'.split(
    ' ',
  ),
);

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_.\-/]+/)
      .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ''))
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Deterministic clustering. Failures are grouped by target repository and rubric first (one
 * proposal has exactly one target); within a group, a failure joins the cluster that holds its
 * most similar member (word overlap of the judge's reasons, at least 25 %), else starts a new one.
 *
 * ponytail: a bag-of-words overlap. The ceiling is paraphrase: two reasons that describe one cause
 * in different words land in separate clusters, and the improver sees each as its own small cluster.
 * It also does not know which instruction file was involved. Upgrade path: an LLM clustering pass
 * (`cluster` purpose on the ledger) once real data shows the split is a problem.
 */
export function clusterFailures(failures: readonly TargetedFailure[]): Cluster[] {
  const groups = new Map<string, TargetedFailure[]>();
  const ordered = [...failures].sort(
    (a, b) => a.sessionId.localeCompare(b.sessionId) || a.rubric.localeCompare(b.rubric),
  );
  for (const f of ordered) {
    const key = `${f.targetRepoId}|${f.rubric}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const clusters: Cluster[] = [];
  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const open: { members: TargetedFailure[]; words: Set<string>[] }[] = [];
    for (const f of group) {
      const words = tokens(f.reason);
      let best: (typeof open)[number] | undefined;
      let bestScore = 0;
      for (const c of open) {
        const score = Math.max(...c.words.map((w) => jaccard(w, words)));
        if (score >= SIMILARITY && score > bestScore) {
          best = c;
          bestScore = score;
        }
      }
      if (best) {
        best.members.push(f);
        best.words.push(words);
      } else open.push({ members: [f], words: [words] });
    }
    for (const c of open) clusters.push(toCluster(c.members, c.words));
  }
  return clusters.sort(
    (a, b) => b.sessionIds.length - a.sessionIds.length || a.id.localeCompare(b.id),
  );
}

function toCluster(members: TargetedFailure[], words: Set<string>[]): Cluster {
  const first = members[0];
  if (!first) throw new Error('empty cluster');
  const sessionIds = [...new Set(members.map((m) => m.sessionId))].sort();
  const counts = new Map<string, number>();
  for (const set of words) for (const w of set) counts.set(w, (counts.get(w) ?? 0) + 1);
  const terms = [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, TOP_TERMS)
    .map(([w]) => w);
  const id = createHash('sha1')
    .update(`${first.targetRepoId}|${first.rubric}|${sessionIds.join(',')}`)
    .digest('hex')
    .slice(0, 12);
  return {
    id,
    targetRepoId: first.targetRepoId,
    rubric: first.rubric,
    failures: members,
    sessionIds,
    terms,
    summary: `${first.rubric}: ${String(sessionIds.length)} session${sessionIds.length === 1 ? '' : 's'} failing${terms.length > 0 ? `, about ${terms.join(', ')}` : ''}`,
  };
}
