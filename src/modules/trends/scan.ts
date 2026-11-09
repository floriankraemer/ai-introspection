import { newId } from '../../platform/db/ids.js';
import { fromJson, toJson } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';
import { git, GitError, revParse } from '../../platform/git/index.js';
import { allowListOf, globToRegExp, type SkillRepos } from '../improvement/index.js';
import type { JudgeProvider } from '../grading/index.js';
import type { RubricStore } from '../rubrics/index.js';

const DAY_MS = 86_400_000;
/** A manual edit is tied to a rubric when a proposal for that file was made this recently. */
const INFER_DAYS = 30;
/** Subject of the merge commit Introspect makes when it accepts a proposal. */
const OWN_MERGE_PREFIX = 'Merge proposal: ';

export interface ScanDeps {
  db: Db;
  workspaceId: string;
  skillRepos: Pick<SkillRepos, 'rows' | 'refreshDefaultBranch'>;
  rubrics: Pick<RubricStore, 'list'>;
  judges: Pick<JudgeProvider, 'current'>;
  /** Re-grades the reference set once per key; resolves to null when it is empty or the key was used. */
  regrade: (key: string) => Promise<string | null>;
  now: () => Date;
}

const strings = (stored: unknown): string[] =>
  stored === null ? [] : (fromJson(stored) as string[]);

/**
 * Finds changes nobody told Introspect about and records them as change events (overview 6.4,
 * ADR-0010): commits on a repository's default branch that touch instruction files and were not
 * made by Introspect, new versions of a rubric, and a change of the judge model. Every event has a
 * unique `ref`, so a scan that runs twice, or dies half way, never records one twice.
 */
export function createChangeScan(deps: ScanDeps) {
  const { db, workspaceId, now } = deps;

  async function insertEvent(e: {
    at: string;
    kind: 'manual_edit' | 'rubric_changed' | 'judge_changed';
    repoId?: string;
    description: string;
    files?: string[];
    rubrics: string[];
    ref: string;
  }): Promise<void> {
    await db
      .insertInto('change_event')
      .values({
        id: newId(),
        workspace_id: workspaceId,
        at: e.at,
        kind: e.kind,
        proposal_id: null,
        repo_id: e.repoId ?? null,
        description: e.description,
        files: toJson(e.files ?? []),
        rubric_names: toJson(e.rubrics),
        ref: e.ref,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'kind', 'ref']).doNothing())
      .execute();
  }

  /** Rubrics whose failing sessions a recent proposal for one of these files answered. */
  async function inferRubrics(files: readonly string[]): Promise<string[]> {
    const since = new Date(now().getTime() - INFER_DAYS * DAY_MS).toISOString();
    const rows = await db
      .selectFrom('proposal')
      .select(['target_path', 'rubric_names'])
      .where('workspace_id', '=', workspaceId)
      .where('created_at', '>=', since)
      .where('target_path', 'in', [...files])
      .execute();
    return [...new Set(rows.flatMap((r) => strings(r.rubric_names)))].sort();
  }

  /** Shas Introspect made: merge commits of accepted proposals, and the heads they merged. */
  async function ownCommits(): Promise<{ merges: Set<string>; heads: Set<string> }> {
    const rows = await db
      .selectFrom('proposal')
      .select(['merge_commit', 'head_sha'])
      .where('workspace_id', '=', workspaceId)
      .where('status', '=', 'accepted')
      .execute();
    const nonNull = (xs: (string | null)[]): Set<string> =>
      new Set(xs.filter((x): x is string => x !== null));
    return {
      merges: nonNull(rows.map((r) => r.merge_commit)),
      heads: nonNull(rows.map((r) => r.head_sha)),
    };
  }

  const isAncestor = (repo: string, a: string, b: string): Promise<boolean> =>
    git(repo, ['merge-base', '--is-ancestor', a, b]).then(
      () => true,
      (e: unknown) => {
        if (e instanceof GitError) return false;
        throw e;
      },
    );

  /**
   * New commits on each enabled repository's default branch. The first scan only remembers the tip:
   * history before Introspect watched is not a change it can judge.
   *
   * ponytail: a pull request squash-merged on GitHub has none of Introspect's shas and is recorded
   * as a manual edit. Upgrade path: match the squash commit's tree against the proposal's head.
   */
  async function manualEdits(): Promise<number> {
    let recorded = 0;
    for (const repo of await deps.skillRepos.rows()) {
      if (!repo.enabled) continue;
      try {
        const branch = await deps.skillRepos.refreshDefaultBranch(repo);
        const head = await revParse(repo.path, `refs/heads/${branch}`);
        const { last_seen_sha: last } = await db
          .selectFrom('skill_repo')
          .select('last_seen_sha')
          .where('id', '=', repo.id)
          .executeTakeFirstOrThrow();
        if (last !== null && last !== head && (await isAncestor(repo.path, last, head))) {
          recorded += await recordCommits(repo, `${last}..${head}`);
        }
        if (last !== head)
          await db
            .updateTable('skill_repo')
            .set({ last_seen_sha: head })
            .where('id', '=', repo.id)
            .execute();
      } catch (e) {
        // One broken repository (moved, no commits yet) must not stop the others.
        console.error(`change scan skipped ${repo.path}`, e);
      }
    }
    return recorded;
  }

  async function recordCommits(
    repo: Awaited<ReturnType<SkillRepos['rows']>>[number],
    range: string,
  ): Promise<number> {
    const allowed = allowListOf(repo).map(globToRegExp);
    const own = await ownCommits();
    const log = await git(repo.path, [
      'log',
      '--first-parent',
      '--reverse',
      '--format=%H%x1f%P%x1f%cI%x1f%s',
      range,
    ]);
    let recorded = 0;
    for (const line of log.split('\n').filter((l) => l !== '')) {
      const [sha = '', parents = '', at = '', subject = ''] = line.split('\x1f');
      const parentList = parents.split(' ').filter((p) => p !== '');
      if (
        own.merges.has(sha) ||
        subject.startsWith(OWN_MERGE_PREFIX) ||
        parentList.some((p) => own.heads.has(p))
      )
        continue;
      const [first] = parentList;
      const names = first
        ? await git(repo.path, ['diff', '--name-only', '-z', first, sha])
        : await git(repo.path, [
            'diff-tree',
            '--root',
            '--no-commit-id',
            '--name-only',
            '-r',
            '-z',
            sha,
          ]);
      const files = names.split('\0').filter((f) => f !== '' && allowed.some((re) => re.test(f)));
      if (files.length === 0) continue;
      await insertEvent({
        at: new Date(at).toISOString(),
        kind: 'manual_edit',
        repoId: repo.id,
        description: subject,
        files,
        rubrics: await inferRubrics(files),
        ref: `${repo.id}:${sha}`,
      });
      recorded += 1;
    }
    return recorded;
  }

  /** A second or later version of a rubric is a change; the first sighting is only the rubric appearing. */
  async function rubricChanges(): Promise<number> {
    await deps.rubrics.list(); // records versions of files edited since the last read
    const versions = await db
      .selectFrom('rubric')
      .select(['id', 'name', 'ordinal', 'created_at'])
      .where('workspace_id', '=', workspaceId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const known = new Set(
      (
        await db
          .selectFrom('change_event')
          .select('ref')
          .where('workspace_id', '=', workspaceId)
          .where('kind', '=', 'rubric_changed')
          .execute()
      ).map((r) => r.ref),
    );
    const seen = new Set<string>();
    let recorded = 0;
    for (const v of versions) {
      if (!seen.has(v.name)) {
        seen.add(v.name);
        continue;
      }
      if (known.has(v.id)) continue;
      // Re-grade first: the key makes it once-only, and an event is not recorded without it having been tried.
      await deps.regrade(`rubric:${v.id}`);
      await insertEvent({
        at: v.created_at,
        kind: 'rubric_changed',
        description: `Rubric ${v.name} changed to v${String(v.ordinal)}`,
        rubrics: [v.name],
        ref: v.id,
      });
      recorded += 1;
    }
    return recorded;
  }

  /**
   * The newest grade names the judge model in use; when the current model differs, the judge changed.
   *
   * ponytail: the event key is the model pair, so going A to B a second time is not recorded again.
   */
  async function judgeChange(): Promise<number> {
    const judge = await deps.judges.current().catch(() => null);
    const newest = await db
      .selectFrom('grade')
      .select('judge_model')
      .where('workspace_id', '=', workspaceId)
      .orderBy('graded_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!judge || !newest || newest.judge_model === judge.model) return 0;
    const ref = `${newest.judge_model}->${judge.model}`;
    await deps.regrade(`judge:${ref}`);
    await insertEvent({
      at: now().toISOString(),
      kind: 'judge_changed',
      description: `Judge model changed from ${newest.judge_model} to ${judge.model}`,
      rubrics: [],
      ref,
    });
    return 1;
  }

  return {
    async run(): Promise<{ manualEdits: number; rubricChanges: number; judgeChanges: number }> {
      return {
        manualEdits: await manualEdits(),
        rubricChanges: await rubricChanges(),
        judgeChanges: await judgeChange(),
      };
    },
  };
}
