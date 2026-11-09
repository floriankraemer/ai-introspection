/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers are typed any */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../platform/db/ids.js';
import { toJson } from '../../platform/db/json.js';
import { ConflictError, NotFoundError } from '../../platform/errors.js';
import { initRepo } from '../../platform/git/index.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import { createJobQueue } from '../../platform/jobs/queue.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';
import { createFakeJudge, createGrading, type Judge } from '../grading/index.js';
import { createSkillRepos } from '../improvement/index.js';
import { createIngest } from '../ingest/index.js';
import { copyStarterRubrics, createRubrics, type RubricStore } from '../rubrics/index.js';
import { createSecretStore, createSettings } from '../settings/index.js';
import { createTrends, type Trends } from './index.js';
import { MAX_COMMITS_PER_SCAN } from './scan.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

const at = (iso: string): Date => new Date(iso);

export function trendsSuite(name: string, make: TestDbFactory): void {
  describe(`trends (${name})`, () => {
    let t: TestDb;
    let dir: string;
    let skills: string;
    let clock: Date;
    let build: (zone: string, maxCommits?: number) => void;
    let judge: Judge;
    let rubrics: RubricStore;
    let trends: Trends;
    let jobs: ReturnType<typeof createJobQueue>;
    let settings: ReturnType<typeof createSettings>;
    let skillRepos: ReturnType<typeof createSkillRepos>;
    let rubricIds: Map<string, string>;

    async function session(startedAt: string, extra: { reference?: boolean } = {}) {
      const id = newId();
      await t.handle.db
        .insertInto('session')
        .values({
          id,
          workspace_id: LOCAL_WORKSPACE_ID,
          user_id: LOCAL_USER_ID,
          agent: 'claude_code',
          native_id: id,
          title: `session ${startedAt}`,
          status: 'ended',
          started_at: startedAt,
          in_reference_set: extra.reference ?? false,
          created_at: startedAt,
        })
        .execute();
      return id;
    }

    async function grade(
      sessionId: string,
      rubric: string,
      passed: boolean,
      o: {
        status?: 'ok' | 'stale' | 'invalid' | 'refused';
        version?: string;
        at?: string;
        judge?: string;
        origin?: 'standard' | 'reference';
      } = {},
    ) {
      const real = (await rubrics.list()).rubrics.find((r) => r.name === rubric);
      const version = o.version ?? real?.version ?? 'v-current';
      let rubricId = o.version === undefined ? real?.id : rubricIds.get(`${rubric}:${version}`);
      if (!rubricId) {
        rubricId = newId();
        rubricIds.set(`${rubric}:${version}`, rubricId);
        await t.handle.db
          .insertInto('rubric')
          .values({
            id: rubricId,
            workspace_id: LOCAL_WORKSPACE_ID,
            name: rubric,
            version,
            ordinal: 1,
            commit_sha: null,
            scale: '[0,1]',
            pass_threshold: 1,
            target_pass_rate: null,
            applies_to: '"all"',
            body_md: 'x',
            created_at: '2026-01-01T00:00:00.000Z',
          })
          .execute();
      }
      await t.handle.db
        .insertInto('grade')
        .values({
          id: newId(),
          workspace_id: LOCAL_WORKSPACE_ID,
          session_id: sessionId,
          rubric_id: rubricId,
          rubric_version: version,
          score: passed ? 1 : 0,
          passed,
          reason: 'r',
          evidence_event_ids: '[]',
          judge_model: o.judge ?? 'fake-judge',
          transport: 'fake',
          status: o.status ?? 'ok',
          graded_at: o.at ?? clock.toISOString(),
          origin: o.origin ?? 'standard',
        })
        .execute();
    }

    /** Sessions that started at `startedAt`, graded for `rubric` with the given outcomes. */
    async function batch(rubric: string, startedAt: string, outcomes: boolean[]) {
      for (const passed of outcomes) await grade(await session(startedAt), rubric, passed);
    }

    const warningOf = () =>
      t.handle.db
        .selectFrom('skill_repo')
        .select(['scan_warning', 'last_seen_sha'])
        .executeTakeFirstOrThrow();
    const skillRepoRows = () => skillRepos.rows();
    const events = (kind: string) =>
      t.handle.db
        .selectFrom('change_event')
        .selectAll()
        .where('kind', '=', kind as 'judge_changed')
        .orderBy('at')
        .execute();
    const batches = async () =>
      (await jobs.list({ limit: 100 })).filter((j) => j.kind === 'grade_batch');

    const bucketOf = async (weeks: number, size: 'week' | 'day', start: string) =>
      (await trends.series(weeks, size)).buckets.find((b) => b.start === start);

    beforeEach(async () => {
      t = await make();
      dir = mkdtempSync(join(tmpdir(), 'introspect-trends-'));
      skills = join(dir, 'skills');
      mkdirSync(skills, { recursive: true });
      await initRepo(skills);
      writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n');
      await copyStarterRubrics(skills);
      git(skills, 'add', '-A');
      git(skills, 'commit', '-qm', 'init', '--allow-empty');
      clock = at('2026-11-11T12:00:00.000Z');
      rubricIds = new Map();
      jobs = createJobQueue(t.handle);
      settings = createSettings(
        t.handle.db,
        LOCAL_WORKSPACE_ID,
        createSecretStore(join(dir, 'data')),
      );
      const ingest = createIngest({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        dataDir: join(dir, 'data'),
        settings,
        queue: jobs,
        pollMode: false,
      });
      skillRepos = createSkillRepos(t.handle.db, LOCAL_WORKSPACE_ID);
      await skillRepos.putGlobal(skills);
      rubrics = createRubrics({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        repoPath: () => Promise.resolve(skills),
        cacheMs: 0,
      });
      judge = createFakeJudge();
      const grading = createGrading({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        settings,
        queue: jobs,
        ingest,
        rubrics,
        judges: { current: () => Promise.resolve(judge) },
        timeZone: 'UTC',
      });
      build = (zone, maxCommits) => {
        trends = createTrends({
          db: t.handle.db,
          workspaceId: LOCAL_WORKSPACE_ID,
          settings,
          ingest,
          grading,
          rubrics,
          judges: { current: () => Promise.resolve(judge) },
          skillRepos,
          timeZone: zone,
          now: () => clock,
          ...(maxCommits !== undefined && { maxCommits }),
        });
      };
      build('UTC');
    });
    afterEach(async () => {
      await t.destroy();
      rmSync(dir, { recursive: true, force: true });
    });

    describe('series', () => {
      it('returns one bucket per ISO week (Monday start), empty ones with a null pass rate', async () => {
        await batch('efficiency', '2026-11-03T10:00:00.000Z', [true, false, true]);
        const { buckets } = await trends.series(4, 'week');
        expect(buckets.map((b) => b.start)).toEqual([
          '2026-10-19T00:00:00.000Z',
          '2026-10-26T00:00:00.000Z',
          '2026-11-02T00:00:00.000Z',
          '2026-11-09T00:00:00.000Z',
        ]);
        expect(buckets[2]?.rubrics.efficiency).toEqual({ passRate: 2 / 3, graded: 3, passed: 2 });
        expect(buckets[0]?.rubrics.efficiency).toEqual({ passRate: null, graded: 0, passed: 0 });
        expect(Object.keys(buckets[0]?.rubrics ?? {}).sort()).toEqual([
          'efficiency',
          'redundant-tests',
          'silent-workaround',
          'verbosity',
        ]);
      });

      it('returns one bucket per day, weeks * 7 of them', async () => {
        await batch('efficiency', '2026-11-11T01:00:00.000Z', [true]);
        const { buckets } = await trends.series(4, 'day');
        expect(buckets).toHaveLength(28);
        expect(buckets.at(-1)?.start).toBe('2026-11-11T00:00:00.000Z');
        expect(buckets.at(-1)?.rubrics.efficiency?.graded).toBe(1);
      });

      it('puts a session in the bucket of its local day: the Sunday-night boundary in Berlin', async () => {
        // CET is UTC+1: 22:59Z is Sunday 23:59, 23:00Z is Monday 00:00.
        await batch('efficiency', '2026-11-08T22:59:00.000Z', [true]);
        await batch('efficiency', '2026-11-08T23:00:00.000Z', [false]);
        build('Europe/Berlin');
        const sunday = await bucketOf(4, 'week', '2026-11-01T23:00:00.000Z');
        const monday = await bucketOf(4, 'week', '2026-11-08T23:00:00.000Z');
        expect(sunday?.rubrics.efficiency).toMatchObject({ graded: 1, passed: 1 });
        expect(monday?.rubrics.efficiency).toMatchObject({ graded: 1, passed: 0 });
        // The same instants fall into one week in UTC.
        build('UTC');
        expect(
          (await bucketOf(4, 'week', '2026-11-02T00:00:00.000Z'))?.rubrics.efficiency?.graded,
        ).toBe(2);
      });

      it('handles a zone whose offset is not a whole hour (Nepal, UTC+5:45)', async () => {
        // 18:14Z is 23:59 on Sunday in Kathmandu, 18:15Z is Monday 00:00.
        await batch('efficiency', '2026-11-08T18:14:00.000Z', [true]);
        await batch('efficiency', '2026-11-08T18:15:00.000Z', [false, false]);
        build('Asia/Kathmandu');
        const buckets = (await trends.series(4, 'week')).buckets;
        const [prev, next] = buckets.slice(-2);
        expect(prev?.rubrics.efficiency?.graded).toBe(1);
        expect(next?.rubrics.efficiency).toMatchObject({ graded: 2, passed: 0 });
        expect(next?.start).toBe('2026-11-08T18:15:00.000Z');
      });

      it('keeps the local midnight right across a DST change', async () => {
        clock = at('2026-03-31T12:00:00.000Z');
        build('Europe/Berlin');
        const { buckets } = await trends.series(4, 'week');
        // Monday 2026-03-23 is CET (+1), Monday 2026-03-30 is CEST (+2).
        expect(buckets.slice(-2).map((b) => b.start)).toEqual([
          '2026-03-22T23:00:00.000Z',
          '2026-03-29T22:00:00.000Z',
        ]);
      });

      it('counts only the newest ok grade per session and rubric, and no stale, invalid or refused ones', async () => {
        const a = await session('2026-11-10T10:00:00.000Z');
        await grade(a, 'efficiency', true, { version: 'v1', at: '2026-11-10T11:00:00.000Z' });
        await grade(a, 'efficiency', false, { version: 'v2', at: '2026-11-10T12:00:00.000Z' });
        const b = await session('2026-11-10T10:00:00.000Z');
        await grade(b, 'efficiency', true, { status: 'stale' });
        await grade(b, 'efficiency', true, { status: 'invalid', version: 'v2' });
        await grade(b, 'efficiency', true, { status: 'refused', version: 'v3' });
        const c = await session('2026-11-10T10:00:00.000Z');
        await grade(c, 'efficiency', true);
        const bucket = (await trends.series(4, 'week')).buckets.at(-1);
        expect(bucket?.rubrics.efficiency).toEqual({ passRate: 0.5, graded: 2, passed: 1 });
      });

      it('reports low samples as they are: one graded session is a rate of 0 or 1 with graded = 1', async () => {
        await batch('verbosity', '2026-11-10T10:00:00.000Z', [false]);
        expect((await trends.series(4, 'week')).buckets.at(-1)?.rubrics.verbosity).toEqual({
          passRate: 0,
          graded: 1,
          passed: 0,
        });
      });

      it('leaves out sessions older than the range', async () => {
        await batch('efficiency', '2026-08-01T10:00:00.000Z', [true]);
        const all = (await trends.series(4, 'week')).buckets.flatMap((b) =>
          Object.values(b.rubrics),
        );
        expect(all.every((p) => p.graded === 0)).toBe(true);
      });

      it('summarizes all time for days = 0', async () => {
        await batch('efficiency', '2026-08-01T10:00:00.000Z', [true]);
        expect((await trends.summary(0)).sessionsGraded).toBe(1);
        expect((await trends.summary(14)).sessionsGraded).toBe(0);
      });

      it('agrees with the summary for the same range', async () => {
        await batch('efficiency', '2026-11-10T10:00:00.000Z', [true, true, false]);
        await batch('efficiency', '2026-11-03T10:00:00.000Z', [false]);
        const summary = await trends.summary(14);
        const buckets = (await trends.series(4, 'week')).buckets.slice(-2);
        const graded = buckets.reduce((n, b) => n + (b.rubrics.efficiency?.graded ?? 0), 0);
        const passed = buckets.reduce((n, b) => n + (b.rubrics.efficiency?.passed ?? 0), 0);
        const card = summary.rubrics.find((r) => r.name === 'efficiency');
        expect(card?.gradedCount).toBe(graded);
        expect(card?.passRate).toBe(passed / graded);
        expect(summary.sessionsGraded).toBe(4);
      });
    });

    describe('change events', () => {
      const FIRST_SHA = () => git(skills, 'rev-parse', 'HEAD');

      async function proposal(target: string, rubricNames: string[]) {
        await t.handle.db
          .insertInto('proposal')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            title: 'p',
            target_path: target,
            diff: '',
            rationale: 'r',
            rubric_names: toJson(rubricNames),
            status: 'accepted',
            created_at: clock.toISOString(),
          })
          .execute();
      }

      it('notes the tip on the first scan and records no history', async () => {
        git(skills, 'commit', '-qm', 'old edit', '--allow-empty');
        expect(await trends.scan()).toMatchObject({ manualEdits: 0 });
        const repo = await t.handle.db
          .selectFrom('skill_repo')
          .select('last_seen_sha')
          .executeTakeFirstOrThrow();
        expect(repo.last_seen_sha).toBe(FIRST_SHA());
      });

      it('records a manual commit that touches instruction files, with its files, once', async () => {
        await trends.scan();
        mkdirSync(join(skills, 'skills'), { recursive: true });
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- be brief\n');
        writeFileSync(join(skills, 'skills', 'review.md'), 'x\n');
        writeFileSync(join(skills, 'notes.txt'), 'not an instruction file\n');
        git(skills, 'add', '-A');
        git(skills, 'commit', '-qm', 'tighten instructions');
        expect(await trends.scan()).toMatchObject({ manualEdits: 1 });
        expect(await trends.scan()).toMatchObject({ manualEdits: 0 });
        const { markers } = await trends.series(4, 'week');
        expect(markers).toEqual([
          expect.objectContaining({
            kind: 'manual_edit',
            title: 'tighten instructions',
            proposalId: null,
            files: ['CLAUDE.md', 'skills/review.md'],
            rubrics: [],
          }),
        ]);
      });

      it('ignores commits that touch no instruction file, and rubric edits (they are rubric changes)', async () => {
        await trends.scan();
        writeFileSync(join(skills, 'notes.txt'), 'x\n');
        git(skills, 'add', '-A');
        git(skills, 'commit', '-qm', 'notes');
        writeFileSync(join(skills, 'rubrics', 'verbosity.md'), 'edited by hand\n');
        git(skills, 'commit', '-qam', 'tune verbosity by hand');
        expect((await trends.scan()).manualEdits).toBe(0);
      });

      it('excludes what Introspect made: its merge commit and the commits of the merged branch', async () => {
        await trends.scan();
        git(skills, 'checkout', '-qb', 'introspect/tighten-1234abcd');
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- from the improver\n');
        git(skills, 'commit', '-qam', 'improver change');
        const head = git(skills, 'rev-parse', 'HEAD');
        git(skills, 'checkout', '-q', 'main');
        git(
          skills,
          'merge',
          '--no-ff',
          '-m',
          'Merge proposal: tighten',
          'introspect/tighten-1234abcd',
        );
        // A pull request merged elsewhere: its message is GitHub's, but its second parent is our head.
        await t.handle.db
          .insertInto('proposal')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            title: 'tighten',
            target_path: 'CLAUDE.md',
            diff: '',
            rationale: 'r',
            head_sha: head,
            status: 'accepted',
            created_at: clock.toISOString(),
          })
          .execute();
        expect((await trends.scan()).manualEdits).toBe(0);
        git(skills, 'checkout', '-qb', 'introspect/pr-1');
        writeFileSync(join(skills, 'AGENTS.md'), 'pr\n');
        git(skills, 'add', '-A');
        git(skills, 'commit', '-qm', 'pr change');
        const prHead = git(skills, 'rev-parse', 'HEAD');
        git(skills, 'checkout', '-q', 'main');
        await t.handle.db.updateTable('proposal').set({ head_sha: prHead }).execute();
        git(
          skills,
          'merge',
          '--no-ff',
          '-m',
          'Merge pull request #7 from x/introspect/pr-1',
          'introspect/pr-1',
        );
        expect((await trends.scan()).manualEdits).toBe(0);
        // A person's commit afterwards is still seen.
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- mine\n');
        git(skills, 'commit', '-qam', 'my edit');
        expect((await trends.scan()).manualEdits).toBe(1);
      });

      it('infers the rubrics a recent proposal for the same file targeted, else none', async () => {
        await proposal('CLAUDE.md', ['verbosity', 'efficiency']);
        await trends.scan();
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- a\n');
        git(skills, 'commit', '-qam', 'edit one');
        mkdirSync(join(skills, 'commands'));
        writeFileSync(join(skills, 'commands', 'x.md'), 'x\n');
        git(skills, 'add', '-A');
        git(skills, 'commit', '-qm', 'edit two');
        await trends.scan();
        const { markers } = await trends.series(4, 'week');
        expect(markers.map((m) => [m.title, m.rubrics])).toEqual([
          ['edit two', []],
          ['edit one', ['efficiency', 'verbosity']],
        ]);
      });

      it('does not follow a history rewrite: it remembers the new tip and warns which span is not tracked', async () => {
        await trends.scan();
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- a\n');
        git(skills, 'commit', '-qam', 'edit');
        await trends.scan();
        const before = git(skills, 'rev-parse', 'HEAD');
        git(skills, 'reset', '-q', '--hard', 'HEAD~1');
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- b\n');
        git(skills, 'commit', '-qam', 'rewritten');
        expect((await trends.scan()).manualEdits).toBe(0);
        const repo = await warningOf();
        expect(repo.scan_warning).toBe(
          `History rewritten on ${skills}; edits between ${before.slice(0, 8)} and ${git(skills, 'rev-parse', '--short=8', 'HEAD')} are not tracked`,
        );
        expect(repo.last_seen_sha).toBe(git(skills, 'rev-parse', 'HEAD'));
      });

      it('skips a commit it cannot read, warns, and moves on instead of blocking the repository', async () => {
        await trends.scan();
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- a\n');
        git(skills, 'commit', '-qam', 'bad one');
        const tree = git(skills, 'rev-parse', 'HEAD^{tree}');
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- b\n');
        git(skills, 'commit', '-qam', 'bad two (its parent tree is gone)');
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- c\n');
        git(skills, 'commit', '-qam', 'good');
        rmSync(join(skills, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
        expect((await trends.scan()).manualEdits).toBe(1);
        const repo = await warningOf();
        expect(repo.scan_warning).toMatch(/Skipped 2 unreadable commit\(s\)/);
        expect(repo.last_seen_sha).toBe(git(skills, 'rev-parse', 'HEAD'));
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- d\n');
        git(skills, 'commit', '-qam', 'next');
        expect((await trends.scan()).manualEdits).toBe(1);
        expect((await warningOf()).scan_warning).toBeNull();
      });

      it('looks at a bounded number of commits per scan (500 by default) and continues with the rest next time', async () => {
        expect(MAX_COMMITS_PER_SCAN).toBe(500);
        build('UTC', 5);
        await trends.scan();
        const base = git(skills, 'rev-parse', 'HEAD');
        // One fast-import stream makes the commits in a moment.
        const stream = Array.from(
          { length: 7 },
          (_, i) =>
            `commit refs/heads/main\ncommitter t <t@t> ${String(1_700_000_000 + i)} +0000\ndata 3\nc${String(i % 10)}\n${i === 0 ? `from ${base}\n` : ''}M 100644 inline CLAUDE.md\ndata 2\n${String(i % 10)}\n\n`,
        ).join('');
        execFileSync('git', ['fast-import', '--quiet'], { cwd: skills, input: stream });
        const head = git(skills, 'rev-parse', 'HEAD');
        expect((await trends.scan()).manualEdits).toBe(5);
        expect((await warningOf()).last_seen_sha).not.toBe(head);
        expect((await trends.scan()).manualEdits).toBe(2);
        expect((await warningOf()).last_seen_sha).toBe(head);
      });

      it('does not replay commits made while a repository was off: enabling it starts from the tip', async () => {
        await trends.scan();
        const [repo] = await skillRepoRows();
        await skillRepos.update(repo?.id ?? '', { enabled: false });
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- while off\n');
        git(skills, 'commit', '-qam', 'edit while off');
        expect((await trends.scan()).manualEdits).toBe(0);
        // Still the old tip while it is off.
        expect((await warningOf()).last_seen_sha).not.toBe(git(skills, 'rev-parse', 'HEAD'));
        await skillRepos.update(repo?.id ?? '', { enabled: true });
        expect((await warningOf()).last_seen_sha).toBe(git(skills, 'rev-parse', 'HEAD'));
        expect((await trends.scan()).manualEdits).toBe(0);
        writeFileSync(join(skills, 'CLAUDE.md'), '# Global\n- after\n');
        git(skills, 'commit', '-qam', 'edit after');
        expect((await trends.scan()).manualEdits).toBe(1);
      });

      it('treats the head and merge of a pull request as ours before the poller has marked it accepted, and the accepted event is the only one', async () => {
        await trends.scan();
        git(skills, 'checkout', '-qb', 'introspect/pr-1');
        writeFileSync(join(skills, 'AGENTS.md'), 'pr\n');
        git(skills, 'add', '-A');
        git(skills, 'commit', '-qm', 'pr change');
        const prHead = git(skills, 'rev-parse', 'HEAD');
        git(skills, 'checkout', '-q', 'main');
        const id = newId();
        await t.handle.db
          .insertInto('proposal')
          .values({
            id,
            workspace_id: LOCAL_WORKSPACE_ID,
            title: 'pr',
            target_path: 'AGENTS.md',
            diff: '',
            rationale: 'r',
            branch: 'introspect/pr-1',
            head_sha: prHead,
            pr_url: 'https://github.com/x/y/pull/1',
            status: 'open', // GitHub merged it, the poller has not looked yet
            created_at: clock.toISOString(),
          })
          .execute();
        git(
          skills,
          'merge',
          '--no-ff',
          '-m',
          'Merge pull request #1 from x/introspect/pr-1',
          'introspect/pr-1',
        );
        expect((await trends.scan()).manualEdits).toBe(0);
        expect(await t.handle.db.selectFrom('change_event').select('id').execute()).toHaveLength(0);
      });

      it('records a new rubric version as a rubric change with a baseline reset, queues one re-grade of the reference set, and not again', async () => {
        const member = await session('2026-11-10T10:00:00.000Z', { reference: true });
        expect((await trends.scan()).rubricChanges).toBe(0);
        const file = join(skills, 'rubrics', 'verbosity.md');
        writeFileSync(file, `${readFileSync(file, 'utf8')}\nAlso count filler words.\n`);
        git(skills, 'commit', '-qam', 'tune verbosity');
        clock = at('2026-11-11T13:00:00.000Z');
        expect((await trends.scan()).rubricChanges).toBe(1);
        expect((await trends.scan()).rubricChanges).toBe(0);
        const series = await trends.series(4, 'week');
        expect(series.markers).toEqual([
          expect.objectContaining({
            kind: 'rubric_changed',
            rubrics: ['verbosity'],
            title: expect.stringMatching(/^Rubric verbosity changed to v\d+$/),
          }),
        ]);
        expect(series.baselineResets).toEqual([
          expect.objectContaining({
            rubric: 'verbosity',
            reason: expect.stringContaining('verbosity'),
          }),
        ]);
        const batches = (await jobs.list({ limit: 50 })).filter((j) => j.kind === 'grade_batch');
        expect(batches).toHaveLength(1);
        expect(batches[0]?.payload).toMatchObject({
          sessionIds: [member],
          force: true,
          origin: 'reference',
          rubrics: ['verbosity'],
        });
      });

      it('queues one re-grade for all triggers of a scan: the union of the changed rubrics, or every rubric after a judge change', async () => {
        await session('2026-11-10T10:00:00.000Z', { reference: true });
        await trends.scan();
        for (const name of ['verbosity', 'efficiency']) {
          const file = join(skills, 'rubrics', `${name}.md`);
          writeFileSync(file, `${readFileSync(file, 'utf8')}\nAlso count filler words.\n`);
        }
        git(skills, 'commit', '-qam', 'tune two rubrics');
        clock = at('2026-11-11T13:00:00.000Z');
        expect((await trends.scan()).rubricChanges).toBe(2);
        let batches = (await jobs.list({ limit: 50 })).filter((j) => j.kind === 'grade_batch');
        expect(batches).toHaveLength(1);
        expect(batches[0]?.payload).toMatchObject({ rubrics: ['efficiency', 'verbosity'] });

        const file = join(skills, 'rubrics', 'silent-workaround.md');
        writeFileSync(file, `${readFileSync(file, 'utf8')}\nMore.\n`);
        git(skills, 'commit', '-qam', 'tune a third');
        judge = createFakeJudge(undefined, 'judge-b');
        clock = at('2026-11-11T14:00:00.000Z');
        expect(await trends.scan()).toMatchObject({ rubricChanges: 1, judgeChanges: 1 });
        batches = (await jobs.list({ limit: 50 })).filter((j) => j.kind === 'grade_batch');
        expect(batches).toHaveLength(2); // one more job, not two
        const latest = batches.find((j) => !('rubrics' in (j.payload as object)));
        expect(latest?.payload).not.toHaveProperty('rubrics'); // a judge change re-grades every rubric
      });

      it('does not re-grade for rubric versions that were there before the first scan (backfill)', async () => {
        await session('2026-11-10T10:00:00.000Z', { reference: true });
        await rubrics.list(); // version 1
        const file = join(skills, 'rubrics', 'verbosity.md');
        writeFileSync(file, `${readFileSync(file, 'utf8')}\nAlso count filler words.\n`);
        git(skills, 'commit', '-qam', 'tune verbosity before trends existed');
        await rubrics.list();
        expect((await trends.scan()).rubricChanges).toBe(1); // still recorded, with its original time
        expect(
          (await jobs.list({ limit: 50 })).filter((j) => j.kind === 'grade_batch'),
        ).toHaveLength(0);
      });

      it('records a judge model change once and re-grades the reference set once', async () => {
        await session('2026-11-10T10:00:00.000Z', { reference: true });
        const s = await session('2026-11-10T10:00:00.000Z');
        await grade(s, 'efficiency', true, { judge: 'old-judge' });
        expect((await trends.scan()).judgeChanges).toBe(1);
        await trends.scan();
        const resets = (await trends.series(4, 'week')).baselineResets;
        expect(resets.map((r) => r.rubric).sort()).toEqual([
          'efficiency',
          'redundant-tests',
          'silent-workaround',
          'verbosity',
        ]);
        expect((await trends.series(4, 'week')).markers).toEqual([]);
        expect(
          (await jobs.list({ limit: 50 })).filter((j) => j.kind === 'grade_batch'),
        ).toHaveLength(1);
      });

      it('records a switch from the settings hook at once, dated by the switch, and the scan does not record it again', async () => {
        await session('2026-11-10T10:00:00.000Z', { reference: true });
        await trends.scan(); // remembers the judge model in use
        clock = at('2026-11-11T13:00:00.000Z');
        judge = createFakeJudge(undefined, 'judge-b');
        expect(await trends.noteJudge()).toBe(1);
        expect(await trends.noteJudge()).toBe(0);
        expect((await trends.scan()).judgeChanges).toBe(0);
        expect(await events('judge_changed')).toEqual([
          expect.objectContaining({
            at: '2026-11-11T13:00:00.000Z',
            ref: 'judge-1',
            description: 'Judge model changed from fake-judge to judge-b',
          }),
        ]);
        expect((await trends.series(4, 'week')).baselineResets[0]?.at).toBe(
          '2026-11-11T13:00:00.000Z',
        );
        expect(await batches()).toHaveLength(1);
      });

      it('finds a switch the hook missed even when the new model has graded before the scan, dated by its first grade', async () => {
        await trends.scan();
        clock = at('2026-11-11T13:00:00.000Z');
        judge = createFakeJudge(undefined, 'judge-b');
        const s = await session('2026-11-10T10:00:00.000Z');
        await grade(s, 'efficiency', true, { judge: 'judge-b', at: '2026-11-11T12:30:00.000Z' });
        await grade(s, 'verbosity', true, { judge: 'judge-b', at: '2026-11-11T12:40:00.000Z' });
        expect((await trends.scan()).judgeChanges).toBe(1);
        expect((await events('judge_changed')).map((e) => e.at)).toEqual([
          '2026-11-11T12:30:00.000Z',
        ]);
      });

      it('records A to B to A to B as three events, each with its own re-grade', async () => {
        await session('2026-11-10T10:00:00.000Z', { reference: true });
        await trends.scan();
        for (const model of ['judge-b', 'fake-judge', 'judge-b']) {
          clock = new Date(clock.getTime() + 3_600_000);
          judge = createFakeJudge(undefined, model);
          await trends.noteJudge();
        }
        expect((await events('judge_changed')).map((e) => [e.ref, e.description])).toEqual([
          ['judge-1', 'Judge model changed from fake-judge to judge-b'],
          ['judge-2', 'Judge model changed from judge-b to fake-judge'],
          ['judge-3', 'Judge model changed from fake-judge to judge-b'],
        ]);
        // The key is the switch, not the pair of models: the second A to B is not swallowed by the first.
        expect(await batches()).toHaveLength(3);
      });

      it('queues nothing automatically when the reference set is empty', async () => {
        const s = await session('2026-11-10T10:00:00.000Z');
        await grade(s, 'efficiency', true, { judge: 'old-judge' });
        await trends.scan();
        expect(
          (await jobs.list({ limit: 50 })).filter((j) => j.kind === 'grade_batch'),
        ).toHaveLength(0);
      });
    });

    describe('change log', () => {
      async function merged(atIso: string, rubricNames: string[], files = ['CLAUDE.md']) {
        const id = newId();
        await t.handle.db
          .insertInto('change_event')
          .values({
            id,
            workspace_id: LOCAL_WORKSPACE_ID,
            at: atIso,
            kind: 'proposal_merged',
            proposal_id: null,
            repo_id: null,
            description: 'Tighten CLAUDE.md',
            files: toJson(files),
            rubric_names: toJson(rubricNames),
            ref: null,
          })
          .execute();
        return id;
      }

      it('compares the window before and after a change and calls a clear gain improved', async () => {
        await merged('2026-11-05T12:00:00.000Z', ['efficiency']);
        await batch('efficiency', '2026-10-31T10:00:00.000Z', [
          true,
          ...Array<boolean>(11).fill(false),
        ]);
        await batch('efficiency', '2026-11-08T10:00:00.000Z', [
          ...Array<boolean>(11).fill(true),
          false,
        ]);
        const [c] = await trends.changes();
        expect(c).toMatchObject({
          kind: 'proposal_merged',
          rubrics: ['efficiency'],
          files: ['CLAUDE.md'],
          before: { graded: 12, window: 7 },
          after: { graded: 12, window: 7 },
          verdict: 'improved',
        });
        expect(c?.before.passRate).toBeCloseTo(1 / 12);
        expect(c?.after.passRate).toBeCloseTo(11 / 12);
      });

      it('calls a clear loss worse and an equal rate no_change', async () => {
        await merged('2026-11-05T12:00:00.000Z', ['verbosity']);
        await batch(
          'verbosity',
          '2026-10-31T10:00:00.000Z',
          [...Array<boolean>(12).fill(true)].map((_, i) => i < 11),
        );
        await batch(
          'verbosity',
          '2026-11-08T10:00:00.000Z',
          [...Array<boolean>(12).fill(false)].map((_, i) => i < 1),
        );
        expect((await trends.changes())[0]?.verdict).toBe('worse');
        await merged('2026-11-08T23:00:00.000Z', ['efficiency']);
        await batch('efficiency', '2026-11-04T10:00:00.000Z', [
          true,
          false,
          true,
          false,
          true,
          false,
          true,
          false,
          true,
          false,
        ]);
        await batch('efficiency', '2026-11-10T10:00:00.000Z', [
          false,
          true,
          false,
          true,
          false,
          true,
          false,
          true,
          false,
          true,
        ]);
        expect((await trends.changes())[0]).toMatchObject({ verdict: 'no_change' });
      });

      it('is too early with fewer than trends.min_graded sessions after the change, and obeys the setting', async () => {
        await merged('2026-11-05T12:00:00.000Z', ['efficiency']);
        await batch('efficiency', '2026-11-01T10:00:00.000Z', [false, false, false, false, false]);
        await batch('efficiency', '2026-11-07T10:00:00.000Z', [true, true, true, true]);
        expect((await trends.changes())[0]).toMatchObject({
          verdict: 'too_early',
          after: { graded: 4 },
        });
        await batch('efficiency', '2026-11-07T11:00:00.000Z', [true]);
        await settings.update({ 'trends.min_graded': 5 });
        expect((await trends.changes())[0]?.verdict).toBe('improved');
      });

      it('shortens the window to the data that exists when the change is recent', async () => {
        await merged('2026-11-10T12:00:00.000Z', ['efficiency']);
        await batch('efficiency', '2026-11-11T09:00:00.000Z', [true]);
        expect((await trends.changes())[0]).toMatchObject({
          after: { graded: 1, window: 7 },
          verdict: 'too_early',
        });
      });

      it('uses the window_days setting', async () => {
        await settings.update({ 'trends.window_days': 2 });
        await merged('2026-11-05T12:00:00.000Z', ['efficiency']);
        await batch('efficiency', '2026-11-04T10:00:00.000Z', [true]); // inside 2 days before
        await batch('efficiency', '2026-11-01T10:00:00.000Z', [false, false]); // outside
        expect((await trends.changes())[0]?.before).toMatchObject({ graded: 1, window: 2 });
      });

      it('compares every current rubric separately for a change that names none, never pooled', async () => {
        await merged('2026-11-05T12:00:00.000Z', []);
        await batch('efficiency', '2026-11-04T10:00:00.000Z', [true]);
        await batch('verbosity', '2026-11-04T10:00:00.000Z', [false]);
        const [c] = await trends.changes();
        expect(c?.perRubric.map((r) => r.rubric)).toEqual([
          'efficiency',
          'redundant-tests',
          'silent-workaround',
          'verbosity',
        ]);
        expect(c?.perRubric.find((r) => r.rubric === 'efficiency')?.before).toEqual({
          graded: 1,
          passRate: 1,
        });
        expect(c?.perRubric.find((r) => r.rubric === 'verbosity')?.before).toEqual({
          graded: 1,
          passRate: 0,
        });
      });

      it('is too early when the sample before the change is too small, however good the after side', async () => {
        await merged('2026-11-05T12:00:00.000Z', ['efficiency']);
        await batch('efficiency', '2026-11-02T10:00:00.000Z', [false, false, false]);
        await batch('efficiency', '2026-11-08T10:00:00.000Z', Array<boolean>(10).fill(true));
        expect((await trends.changes())[0]).toMatchObject({ verdict: 'too_early' });
      });

      it('calls 7/10 against 10/10 no change (Fisher, p = 0.21)', async () => {
        await merged('2026-11-05T12:00:00.000Z', ['efficiency']);
        await batch('efficiency', '2026-11-02T10:00:00.000Z', [
          ...Array<boolean>(7).fill(true),
          ...Array<boolean>(3).fill(false),
        ]);
        await batch('efficiency', '2026-11-08T10:00:00.000Z', Array<boolean>(10).fill(true));
        const [c] = await trends.changes();
        expect(c).toMatchObject({ verdict: 'no_change' });
        expect(c?.perRubric[0]?.pValue).toBeCloseTo(0.2105, 3);
      });

      it('counts sessions, not session x rubric pairs: three rubrics do not triple the sample', async () => {
        await settings.update({ 'trends.min_graded': 5 });
        await merged('2026-11-05T12:00:00.000Z', ['efficiency', 'verbosity', 'redundant-tests']);
        for (const rubric of ['efficiency', 'verbosity', 'redundant-tests']) {
          await batch(rubric, '2026-11-02T10:00:00.000Z', [true, true, false, false, false]);
          await batch(rubric, '2026-11-08T10:00:00.000Z', [true, true, true, true, false]);
        }
        const [c] = await trends.changes();
        // Pooled over the three rubrics (6/15 against 12/15 pairs) that would read as improved.
        expect(c?.verdict).toBe('no_change');
        expect(c?.perRubric.every((r) => r.before.graded === 5 && r.after.graded === 5)).toBe(true);
      }, 20_000);

      it('applies Holm over the rubrics: a p of 0.07 wins alone and loses next to a second rubric', async () => {
        await merged('2026-11-05T12:00:00.000Z', ['efficiency']);
        await batch('efficiency', '2026-11-02T10:00:00.000Z', [
          ...Array<boolean>(3).fill(true),
          ...Array<boolean>(7).fill(false),
        ]);
        await batch('efficiency', '2026-11-08T10:00:00.000Z', [
          ...Array<boolean>(8).fill(true),
          ...Array<boolean>(2).fill(false),
        ]);
        expect((await trends.changes())[0]).toMatchObject({ verdict: 'improved' });
        await t.handle.db.deleteFrom('change_event').execute();
        await merged('2026-11-05T12:00:00.000Z', ['efficiency', 'verbosity']);
        await batch('verbosity', '2026-11-02T10:00:00.000Z', Array<boolean>(10).fill(true));
        await batch('verbosity', '2026-11-08T10:00:00.000Z', Array<boolean>(10).fill(true));
        const [c] = await trends.changes();
        expect(c?.verdict).toBe('no_change');
        expect(c?.perRubric.map((r) => [r.rubric, r.verdict])).toEqual([
          ['efficiency', 'no_change'],
          ['verbosity', 'no_change'],
        ]);
      });

      it('shows the rubric with the smallest p-value at the top level, and every rubric under perRubric', async () => {
        await merged('2026-11-05T12:00:00.000Z', ['efficiency', 'verbosity']);
        await batch('efficiency', '2026-11-02T10:00:00.000Z', Array<boolean>(10).fill(true));
        await batch('efficiency', '2026-11-08T10:00:00.000Z', Array<boolean>(10).fill(true));
        await batch('verbosity', '2026-11-02T10:00:00.000Z', Array<boolean>(10).fill(false));
        await batch('verbosity', '2026-11-08T10:00:00.000Z', Array<boolean>(10).fill(true));
        const [c] = await trends.changes();
        expect(c?.verdict).toBe('improved');
        expect(c?.before).toMatchObject({ graded: 10, passRate: 0 });
        expect(c?.after).toMatchObject({ graded: 10, passRate: 1 });
        expect(c?.perRubric.map((r) => [r.rubric, r.verdict])).toEqual([
          ['efficiency', 'no_change'],
          ['verbosity', 'improved'],
        ]);
        expect(c?.perRubric[0]?.pValue).toBeCloseTo(1, 5);
      });

      it('never compares across a baseline reset of the rubric: the before side stops at the reset', async () => {
        await t.handle.db
          .insertInto('change_event')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            at: '2026-11-03T00:00:00.000Z',
            kind: 'rubric_changed',
            proposal_id: null,
            repo_id: null,
            description: 'Rubric efficiency changed to v2',
            files: '[]',
            rubric_names: toJson(['efficiency']),
            ref: 'x',
          })
          .execute();
        await merged('2026-11-05T12:00:00.000Z', ['efficiency']);
        await batch('efficiency', '2026-11-02T10:00:00.000Z', [false, false, false]); // old yardstick
        await batch('efficiency', '2026-11-04T10:00:00.000Z', [true]);
        const changes = await trends.changes();
        const proposal = changes.find((c) => c.kind === 'proposal_merged');
        expect(proposal?.before).toMatchObject({ graded: 1, passRate: 1 });
        const rubric = changes.find((c) => c.kind === 'rubric_changed');
        expect(rubric).toMatchObject({
          before: { graded: 0, passRate: null },
          verdict: 'too_early',
        });
      });

      it('lists the newest change first', async () => {
        await merged('2026-11-01T12:00:00.000Z', ['efficiency']);
        await merged('2026-11-06T12:00:00.000Z', ['efficiency']);
        expect((await trends.changes()).map((c) => c.at)).toEqual([
          '2026-11-06T12:00:00.000Z',
          '2026-11-01T12:00:00.000Z',
        ]);
      });
    });

    describe('reference re-grades', () => {
      it('leave past buckets unchanged: only standard grades count', async () => {
        const id = await session('2026-11-03T10:00:00.000Z', { reference: true });
        await grade(id, 'efficiency', true, { at: '2026-11-03T11:00:00.000Z' });
        const week = '2026-11-02T00:00:00.000Z';
        const before = await bucketOf(4, 'week', week);
        expect(before?.rubrics.efficiency).toEqual({ passRate: 1, graded: 1, passed: 1 });
        // Today's judge and rubric version fail it; that must not rewrite the week it belongs to.
        await grade(id, 'efficiency', false, {
          version: 'v2',
          judge: 'judge-b',
          origin: 'reference',
        });
        expect(await bucketOf(4, 'week', week)).toEqual(before);
        expect(
          (await trends.summary(14)).rubrics.find((r) => r.name === 'efficiency'),
        ).toMatchObject({
          passRate: 1,
        });
      });

      it('leave change windows unchanged too', async () => {
        const id = await session('2026-11-03T10:00:00.000Z', { reference: true });
        await grade(id, 'efficiency', true, { at: '2026-11-03T11:00:00.000Z' });
        await t.handle.db
          .insertInto('change_event')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            at: '2026-11-05T12:00:00.000Z',
            kind: 'proposal_merged',
            proposal_id: null,
            repo_id: null,
            description: 'x',
            files: '[]',
            rubric_names: toJson(['efficiency']),
            ref: null,
          })
          .execute();
        await grade(id, 'efficiency', false, { version: 'v2', origin: 'reference' });
        expect((await trends.changes())[0]?.perRubric[0]?.before).toEqual({
          graded: 1,
          passRate: 1,
        });
      });
    });

    describe('reference set', () => {
      it('adds, pins and removes sessions, and lists members with their grades', async () => {
        const id = await session('2026-11-10T10:00:00.000Z');
        await grade(id, 'efficiency', false);
        await trends.reference.set(id, true);
        await trends.reference.set(id, true);
        const row = await t.handle.db
          .selectFrom('session')
          .select(['pinned', 'in_reference_set'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        expect([Boolean(row.pinned), Boolean(row.in_reference_set)]).toEqual([true, true]);
        expect(await trends.reference.list()).toEqual([
          expect.objectContaining({
            id,
            grades: [{ rubric: 'efficiency', passed: false, status: 'ok' }],
          }),
        ]);
        await trends.reference.set(id, false);
        expect(await trends.reference.list()).toEqual([]);
        const after = await t.handle.db
          .selectFrom('session')
          .select('pinned')
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        expect(Boolean(after.pinned)).toBe(true);
      });

      it('refuses a 21st member and an unknown session', async () => {
        for (let i = 0; i < trends.reference.target; i += 1)
          await trends.reference.set(await session('2026-11-10T10:00:00.000Z'), true);
        await expect(
          trends.reference.set(await session('2026-11-10T10:00:00.000Z'), true),
        ).rejects.toBeInstanceOf(ConflictError);
        await expect(trends.reference.set(newId(), true)).rejects.toBeInstanceOf(NotFoundError);
      });

      it.skipIf(name !== 'postgres')(
        'lets exactly one of two concurrent adds take the last place',
        async () => {
          for (let i = 0; i < trends.reference.target - 1; i += 1)
            await trends.reference.set(await session('2026-11-10T10:00:00.000Z'), true);
          const ingestOn = (db: typeof t.handle.db) =>
            createIngest({
              db,
              workspaceId: LOCAL_WORKSPACE_ID,
              userId: LOCAL_USER_ID,
              dataDir: join(dir, 'data'),
              settings,
              queue: jobs,
              pollMode: false,
            });
          const first = ingestOn(t.handle.db);
          const other = ingestOn(t.open().db);
          const a = await session('2026-11-10T10:00:00.000Z');
          const b = await session('2026-11-10T10:00:00.000Z');
          const results = await Promise.all([
            first.setReference(a, true, trends.reference.target),
            other.setReference(b, true, trends.reference.target),
          ]);
          expect(results.sort()).toEqual(['full', 'ok']);
          expect(await trends.reference.list()).toHaveLength(trends.reference.target);
        },
      );

      it('queues a forced re-grade of exactly the members on demand, and refuses when empty', async () => {
        await expect(trends.reference.regrade()).rejects.toBeInstanceOf(ConflictError);
        const a = await session('2026-11-10T10:00:00.000Z');
        await session('2026-11-10T10:00:00.000Z');
        await trends.reference.set(a, true);
        const id = await trends.reference.regrade();
        const job = await jobs.get(id);
        expect(job).toMatchObject({ kind: 'grade_batch' });
        expect(job?.payload).toMatchObject({
          sessionIds: [a],
          force: true,
          origin: 'reference',
        });
        expect(dirname(skills)).toBe(dir);
      });
    });
  });
}
