import { newId } from '../../platform/db/ids.js';
import { fromJson, toJson } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';
import { git, GitError, revParse } from '../../platform/git/index.js';
import { allowListOf, globToRegExp, type SkillRepos } from '../improvement/index.js';
import type { JudgeProvider } from '../grading/index.js';
import type { RubricStore } from '../rubrics/index.js';

const DAY_MS = 86_400_000;
/** At most this many commits of one repository are examined per scan; the rest follow in the next scan. */
export const MAX_COMMITS_PER_SCAN = 500;
/** `setting` rows the scan keeps for itself; they are not user settings and the settings schema ignores them. */
const LAST_SCAN_KEY = 'trends.last_scan_at';
const LAST_JUDGE_KEY = 'trends.last_judge_model';
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
  /**
   * Re-grades the reference set with these rubrics (all when none are named), once per key;
   * resolves to null when the set is empty or the key was used.
   */
  regrade: (rubrics: readonly string[] | undefined, key: string) => Promise<string | null>;
  now: () => Date;
  /** Commits looked at per repository and scan; default MAX_COMMITS_PER_SCAN. */
  maxCommits?: number;
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

  /**
   * Shas Introspect made: merge commits of accepted proposals, and the heads of every proposal that
   * has a branch or pull request, whatever its status. A pull request is merged on GitHub before the
   * poller marks the proposal accepted; the scan must not see that merge as a person's edit.
   */
  async function ownCommits(): Promise<{ merges: Set<string>; heads: Set<string> }> {
    const rows = await db
      .selectFrom('proposal')
      .select(['merge_commit', 'head_sha'])
      .where('workspace_id', '=', workspaceId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'accepted'),
          eb('branch', 'is not', null),
          eb('pr_url', 'is not', null),
        ]),
      )
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

  const short = (sha: string): string => sha.slice(0, 8);

  /**
   * New commits on each enabled repository's default branch. The first scan only remembers the tip:
   * history before Introspect watched is not a change it can judge (enabling a repository again
   * resets its tip the same way).
   *
   * A broken commit or repository never blocks the scan: what cannot be read is skipped and
   * recorded as the repository's scan warning (the doctor shows it). A rewritten history is not
   * followed; the warning says which span is not tracked.
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
        if (last === head) continue;
        let seen = head;
        let warning: string | null = null;
        if (last !== null) {
          if (await isAncestor(repo.path, last, head)) {
            const r = await recordCommits(repo, last, head);
            recorded += r.recorded;
            seen = r.upTo;
            warning = r.warning;
          } else {
            warning = `History rewritten on ${repo.path}; edits between ${short(last)} and ${short(head)} are not tracked`;
          }
        }
        await setWarning(repo.id, warning, seen);
      } catch (e) {
        // One broken repository (moved, no commits yet) must not stop the others.
        console.error(`change scan skipped ${repo.path}`, e);
        await setWarning(repo.id, `Change scan failed on ${repo.path}: ${message(e)}`).catch(
          () => undefined,
        );
      }
    }
    return recorded;
  }

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  /** Remembers how far the scan got; `seen` is left alone when only a warning is recorded. */
  async function setWarning(repoId: string, warning: string | null, seen?: string): Promise<void> {
    await db
      .updateTable('skill_repo')
      .set({
        ...(seen !== undefined && { last_seen_sha: seen }),
        ...(warning !== null || seen !== undefined ? { scan_warning: warning } : {}),
      })
      .where('id', '=', repoId)
      .execute();
  }

  /**
   * Records the commits of `last..head` (first parent only), oldest first, at most
   * MAX_COMMITS_PER_SCAN of them; `upTo` is the last commit looked at, where the next scan resumes.
   * A commit that cannot be read is skipped and counted in the warning.
   */
  async function recordCommits(
    repo: Awaited<ReturnType<SkillRepos['rows']>>[number],
    last: string,
    head: string,
  ): Promise<{ recorded: number; upTo: string; warning: string | null }> {
    const range = `${last}..${head}`;
    const allowed = allowListOf(repo).map(globToRegExp);
    const own = await ownCommits();
    const total = Number(await git(repo.path, ['rev-list', '--first-parent', '--count', range]));
    const skip = Math.max(0, total - (deps.maxCommits ?? MAX_COMMITS_PER_SCAN));
    let log: string;
    try {
      log = await git(repo.path, [
        'log',
        '--first-parent',
        `--skip=${String(skip)}`,
        '--reverse',
        '--format=%H%x1f%P%x1f%cI%x1f%s',
        range,
      ]);
    } catch (e) {
      return {
        recorded: 0,
        upTo: head,
        warning: `Cannot read the commits of ${repo.path} between ${short(last)} and ${short(head)}; edits there are not tracked (${message(e)})`,
      };
    }
    let recorded = 0;
    const unreadable: string[] = [];
    let upTo = head;
    const lines = log.split('\n').filter((l) => l !== '');
    for (const line of lines) {
      const [sha = '', parents = '', at = '', subject = ''] = line.split('\x1f');
      upTo = sha;
      const parentList = parents.split(' ').filter((p) => p !== '');
      if (
        own.merges.has(sha) ||
        own.heads.has(sha) ||
        subject.startsWith(OWN_MERGE_PREFIX) ||
        parentList.some((p) => own.heads.has(p))
      )
        continue;
      try {
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
      } catch (e) {
        console.error(`change scan skipped commit ${sha} of ${repo.path}`, e);
        unreadable.push(short(sha));
      }
    }
    return {
      recorded,
      upTo: skip > 0 ? upTo : head,
      warning:
        unreadable.length === 0
          ? null
          : `Skipped ${String(unreadable.length)} unreadable commit(s) of ${repo.path}: ${unreadable.slice(0, 5).join(', ')}; edits in them are not tracked`,
    };
  }

  async function readState<T>(key: string): Promise<T | null> {
    const row = await db
      .selectFrom('setting')
      .select('value')
      .where('workspace_id', '=', workspaceId)
      .where('key', '=', key)
      .executeTakeFirst();
    return row ? (fromJson(row.value) as T) : null;
  }

  async function writeState(key: string, value: object): Promise<void> {
    const stored = toJson(value);
    await db
      .insertInto('setting')
      .values({ workspace_id: workspaceId, key, value: stored, updated_at: now().toISOString() })
      .onConflict((oc) =>
        oc
          .columns(['workspace_id', 'key'])
          .doUpdateSet({ value: stored, updated_at: now().toISOString() }),
      )
      .execute();
  }

  /** What one scan wants re-graded: the union of its triggers, queued as a single job. */
  interface Triggers {
    rubrics: Set<string>;
    /** A judge change: every rubric. */
    all: boolean;
    keys: string[];
  }
  const noTriggers = (): Triggers => ({ rubrics: new Set(), all: false, keys: [] });

  async function flush(t: Triggers): Promise<void> {
    if (t.keys.length === 0) return;
    await deps.regrade(t.all ? undefined : [...t.rubrics].sort(), t.keys.sort().join('+'));
  }

  interface RubricVersion {
    id: string;
    name: string;
    ordinal: number;
    created_at: string;
  }

  /** A second or later version of a rubric is a change; the first sighting is only the rubric appearing. */
  async function unrecordedRubricChanges(): Promise<RubricVersion[]> {
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
    return versions.filter((v) => {
      if (!seen.has(v.name)) {
        seen.add(v.name);
        return false;
      }
      return !known.has(v.id);
    });
  }

  const recordRubricChange = (v: RubricVersion): Promise<void> =>
    insertEvent({
      at: v.created_at,
      kind: 'rubric_changed',
      description: `Rubric ${v.name} changed to v${String(v.ordinal)}`,
      rubrics: [v.name],
      ref: v.id,
    });

  interface JudgeMark {
    model: string;
    /** When the judge started using this model. */
    at: string;
    /** Counts the switches; the event of switch N is `judge-N`, which no purge of old jobs can make reusable. */
    seq: number;
  }
  interface JudgeSwitch {
    id: string;
    from: string;
    to: string;
    at: string;
    mark: JudgeMark;
  }

  /**
   * Compares the effective judge model with the persisted watermark. A switch happened when they
   * differ; its time is that of the first grade by the new model after the watermark (the scan may
   * notice late), else now. With no watermark yet it starts from the newest grade's model, else from
   * the current one (and is saved at once, so later switches are seen).
   */
  async function detectJudgeSwitch(): Promise<JudgeSwitch | null> {
    const judge = await deps.judges.current().catch(() => null);
    if (!judge) return null;
    let mark = await readState<JudgeMark>(LAST_JUDGE_KEY);
    if (!mark) {
      const newest = await db
        .selectFrom('grade')
        .select(['judge_model', 'graded_at'])
        .where('workspace_id', '=', workspaceId)
        .orderBy('graded_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      mark = newest
        ? { model: newest.judge_model, at: newest.graded_at, seq: 0 }
        : { model: judge.model, at: now().toISOString(), seq: 0 };
      if (mark.model === judge.model) await writeState(LAST_JUDGE_KEY, mark);
    }
    if (mark.model === judge.model) return null;
    const first = await db
      .selectFrom('grade')
      .select((eb) => eb.fn.min('graded_at').as('at'))
      .where('workspace_id', '=', workspaceId)
      .where('judge_model', '=', judge.model)
      .where('graded_at', '>', mark.at)
      .executeTakeFirst();
    const nowIso = now().toISOString();
    const at = first?.at && first.at < nowIso ? first.at : nowIso;
    const seq = mark.seq + 1;
    return {
      id: `judge-${String(seq)}`,
      from: mark.model,
      to: judge.model,
      at,
      mark: { model: judge.model, at, seq },
    };
  }

  /** The event first, the watermark second: a crash in between records the same switch again, which the event key ignores. */
  async function commitJudgeSwitch(sw: JudgeSwitch): Promise<void> {
    await insertEvent({
      at: sw.at,
      kind: 'judge_changed',
      description: `Judge model changed from ${sw.from} to ${sw.to}`,
      rubrics: [],
      ref: sw.id,
    });
    await writeState(LAST_JUDGE_KEY, sw.mark);
  }

  return {
    /**
     * Records a judge switch now and queues the reference re-grade; called when settings change,
     * so the event carries the switch time. The scan finds the same switch if this never ran.
     */
    async noteJudge(): Promise<number> {
      const sw = await detectJudgeSwitch();
      if (!sw) return 0;
      await flush({ ...noTriggers(), all: true, keys: [`judge:${sw.id}`] });
      await commitJudgeSwitch(sw);
      return 1;
    },

    async run(): Promise<{ manualEdits: number; rubricChanges: number; judgeChanges: number }> {
      // The first scan only learns what exists: rubric versions found then are history, not changes to re-grade for.
      const backfill = (await readState(LAST_SCAN_KEY)) === null;
      const manualEditsCount = await manualEdits();
      const triggers = noTriggers();
      const rubricVersions = await unrecordedRubricChanges();
      if (!backfill)
        for (const v of rubricVersions) {
          triggers.rubrics.add(v.name);
          triggers.keys.push(`rubric:${v.id}`);
        }
      const sw = await detectJudgeSwitch();
      if (sw) {
        triggers.all = true;
        triggers.keys.push(`judge:${sw.id}`);
      }
      // Queue first: the key makes it once-only, and an event is not recorded without it having been tried.
      await flush(triggers);
      for (const v of rubricVersions) await recordRubricChange(v);
      if (sw) await commitJudgeSwitch(sw);
      await writeState(LAST_SCAN_KEY, { at: now().toISOString() });
      return {
        manualEdits: manualEditsCount,
        rubricChanges: rubricVersions.length,
        judgeChanges: sw ? 1 : 0,
      };
    },
  };
}
