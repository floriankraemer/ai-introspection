/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers are typed any */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../platform/db/ids.js';
import { fromJson } from '../../platform/db/json.js';
import { BudgetExceededError } from '../../platform/errors.js';
import { initRepo } from '../../platform/git/index.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import { createJobQueue } from '../../platform/jobs/queue.js';
import { DeferJob } from '../../platform/jobs/worker.js';
import { writeFixtureSources } from '../../platform/testkit/agent-fixtures.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';
import { createIngest, type IngestService } from '../ingest/index.js';
import { copyStarterRubrics, createRubrics, type RubricStore } from '../rubrics/index.js';
import { createSecretStore, createSettings, type SettingsService } from '../settings/index.js';
import {
  createFakeJudge,
  createGrading,
  GRADE_BATCH_JOB,
  GRADE_SESSION_JOB,
  type Grading,
} from './index.js';
import type { FakeDecision } from './judge-fake.js';
import type { JudgeRequest } from './types.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export function gradingSuite(name: string, make: TestDbFactory): void {
  describe(`grading (${name})`, () => {
    let t: TestDb;
    let dir: string;
    let repo: string;
    let ingest: IngestService;
    let settings: SettingsService;
    let rubrics: RubricStore;
    let grading: Grading;
    let decide: ((req: JudgeRequest) => FakeDecision) | undefined;
    const queue = () => createJobQueue(t.handle);
    let claudeId: string;
    let codexId: string;

    beforeEach(async () => {
      t = await make();
      dir = mkdtempSync(join(tmpdir(), 'introspect-grading-'));
      const sources = writeFixtureSources(dir);
      settings = createSettings(
        t.handle.db,
        LOCAL_WORKSPACE_ID,
        createSecretStore(join(dir, 'data')),
      );
      ingest = createIngest({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        dataDir: join(dir, 'data'),
        settings,
        queue: queue(),
        pollMode: false,
      });
      await ingest.sources.add('claude_code', sources.claude);
      await ingest.sources.add('codex', sources.codex);
      await ingest.importAll();
      const ids = await t.handle.db.selectFrom('session').select(['id', 'agent']).execute();
      claudeId = ids.find((s) => s.agent === 'claude_code')?.id ?? '';
      codexId = ids.find((s) => s.agent === 'codex')?.id ?? '';

      repo = join(dir, 'skills');
      await import('node:fs/promises').then((fs) => fs.mkdir(repo, { recursive: true }));
      await initRepo(repo);
      await copyStarterRubrics(repo);
      rubrics = createRubrics({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        repoPath: () => Promise.resolve(repo),
        cacheMs: 0,
      });
      decide = undefined;
      const judge = createFakeJudge((req) => {
        if (decide) return decide(req);
        // The default rule of the fake judge, spelled out so the test can override it.
        const failed = [...req.trace.matchAll(/^\[(e\d+)\] \+\d+s \S+ ✕/gm)].map((m) => m[1] ?? '');
        return {
          score: failed.length >= 3 ? Math.min(...req.rubric.scale) : Math.max(...req.rubric.scale),
          reason: `${String(failed.length)} failed events`,
          evidence: failed.slice(0, 3),
        };
      });
      grading = createGrading({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        settings,
        queue: queue(),
        ingest,
        rubrics,
        judges: { current: () => Promise.resolve(judge) },
        sweepDays: 36_500, // the fixture sessions are old
      });
    });
    afterEach(async () => {
      await t.destroy();
      rmSync(dir, { recursive: true, force: true });
    });

    const queuedGradeJobs = async () =>
      (
        await t.handle.db
          .selectFrom('job')
          .selectAll()
          .where('kind', '=', GRADE_SESSION_JOB)
          .where('status', '=', 'queued')
          .execute()
      ).map((j) => ({
        ...j,
        payload: fromJson(j.payload) as { sessionId: string; rubricName: string },
      }));
    const runJobs = async (): Promise<void> => {
      for (const j of await queuedGradeJobs())
        await grading.handlers[GRADE_SESSION_JOB]?.run({ id: j.id, payload: j.payload } as never);
    };
    const gradeCount = async (): Promise<number> =>
      Number(
        (
          await t.handle.db
            .selectFrom('grade')
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );

    describe('rubric store over git', () => {
      it('versions a rubric by blob sha, commits UI edits and keeps old versions', async () => {
        const first = await rubrics.get('efficiency');
        expect(first).toMatchObject({ ordinal: 1, passThreshold: 0.6, appliesTo: 'all' });
        expect(first?.version).toBe(git(repo, 'hash-object', 'rubrics/efficiency.md'));

        const saved = await rubrics.update('efficiency', {
          body: 'A shorter rubric body.\n\n- 1.0 good\n- 0.0 bad',
          passThreshold: 0.8,
          message: 'tighten efficiency',
        });
        expect(saved.ordinal).toBe(2);
        expect(saved.version).not.toBe(first?.version);
        expect(saved.passThreshold).toBe(0.8);
        expect(git(repo, 'log', '-1', '--format=%s', '--', 'rubrics/efficiency.md')).toBe(
          'tighten efficiency',
        );
        expect(git(repo, 'status', '--porcelain')).toBe('');
        expect((await rubrics.history('efficiency')).map((v) => v.ordinal)).toEqual([2, 1]);
        const rows = await t.handle.db
          .selectFrom('rubric')
          .select('version')
          .where('name', '=', 'efficiency')
          .execute();
        expect(rows.map((r) => r.version).sort()).toEqual([first?.version, saved.version].sort());
      });

      it('creates a rubric from a whole file and reports an invalid file without failing', async () => {
        await rubrics.update('tidy', {
          body: '---\nname: tidy\nscale: [0.0, 1.0]\npass_threshold: 1.0\napplies_to: all\n---\nIs it tidy?',
        });
        expect((await rubrics.get('tidy'))?.scale).toEqual([0, 1]);
        writeFileSync(join(repo, 'rubrics', 'broken.md'), '---\nname: broken\nscale: nope\n---\nx');
        const { rubrics: list, problems } = await rubrics.list();
        expect(list.map((r) => r.name)).toContain('tidy');
        expect(problems).toEqual([{ name: 'broken', error: expect.stringContaining('scale') }]);
      });
    });

    describe('grading flow', () => {
      it('grades flagged sessions on the sweep, validates evidence and wires grades into the session APIs', async () => {
        expect(await grading.sweep()).toBeGreaterThanOrEqual(4);
        await runJobs();

        const detail = await grading.sessions.get(claudeId);
        expect(detail?.grades.map((g) => g.rubric)).toEqual([
          'efficiency',
          'redundant-tests',
          'silent-workaround',
          'verbosity',
        ]);
        const events = await ingest.sessions.events(claudeId, { filter: 'all', limit: 500 });
        const eventIds = new Set(events?.items.map((e) => e.id));
        for (const g of detail?.grades ?? []) {
          expect(g).toMatchObject({
            passed: false,
            judgeModel: 'fake-judge',
            transport: 'fake',
            trusted: false,
            status: 'ok',
          });
          expect(g.evidenceEventIds.length).toBeGreaterThan(0);
          for (const id of g.evidenceEventIds) expect(eventIds.has(id)).toBe(true);
        }

        const evidence = await grading.sessions.events(claudeId, {
          filter: 'evidence',
          limit: 500,
        });
        expect(new Set(evidence?.items.map((e) => e.id))).toEqual(
          new Set(detail?.grades.flatMap((g) => g.evidenceEventIds)),
        );

        const failed = await grading.sessions.list({ result: 'failed_any', limit: 50 });
        expect(failed.items.map((s) => s.id)).toEqual([claudeId]);
        expect(failed.items[0]?.grades).toHaveLength(4);
        expect(failed.items[0]?.notGradedReason).toBeNull();
        const notGraded = await grading.sessions.list({ result: 'not_graded', limit: 50 });
        expect(notGraded.items.map((s) => s.id)).not.toContain(claudeId);

        // A second sweep finds nothing left to do.
        expect(await grading.sweep()).toBe(0);
      });

      it('computes passed from the threshold, never from the judge', async () => {
        decide = () => ({ score: 0.6, reason: 'borderline', evidence: ['e0'] });
        await grading.gradeNow({ sessionIds: [claudeId], policy: false });
        const grades = (await grading.sessions.get(claudeId))?.grades ?? [];
        expect(grades.find((g) => g.rubric === 'efficiency')).toMatchObject({
          score: 0.6,
          passed: true, // pass_threshold 0.6
        });
        expect(grades.find((g) => g.rubric === 'silent-workaround')?.status).toBe('invalid'); // 0.6 is off its scale
      });

      it('drops evidence ids that are not in the trace and retries once before marking a grade invalid', async () => {
        let calls = 0;
        decide = () => {
          calls += 1;
          return { score: 0, reason: 'bad', evidence: ['e99999', 'not-an-id'] };
        };
        const summary = await grading.gradeNow({ sessionIds: [claudeId], policy: false });
        expect(summary.failed).toBe(0);
        expect(calls).toBe(8); // 4 rubrics x (first try + one retry)
        const grades = (await grading.sessions.get(claudeId))?.grades ?? [];
        expect(grades.every((g) => g.status === 'invalid' && g.passed === null)).toBe(true);
        expect(grades.every((g) => g.evidenceEventIds.length === 0)).toBe(true);
        const trendless = await grading.trendRubrics(new Date(0));
        expect(trendless.sessionsGraded).toBe(0); // invalid grades never count toward pass rates
      });

      it('lets a passing score stand without evidence and drops unknown ids', async () => {
        decide = () => ({ score: 1, reason: 'fine', evidence: ['e99999'] });
        await grading.gradeNow({ sessionIds: [codexId], policy: false });
        const grades = (await grading.sessions.get(codexId))?.grades ?? [];
        expect(grades.every((g) => g.passed === true && g.evidenceEventIds.length === 0)).toBe(
          true,
        );
      });

      it('re-grades in place: unique per session, rubric version and judge model', async () => {
        await grading.gradeNow({ sessionIds: [claudeId], policy: false });
        const before = await gradeCount();
        await grading.gradeNow({ sessionIds: [claudeId], policy: false });
        expect(await gradeCount()).toBe(before); // skipped: already graded
        const id = await grading.enqueueBatch({ sessionIds: [claudeId], force: true });
        const job = await queue().get(id);
        await grading.handlers[GRADE_BATCH_JOB]?.run({ id, payload: job?.payload } as never);
        expect(await gradeCount()).toBe(before); // replaced, not added
      });

      it('applies the policy: only flagged or sampled sessions, applies_to narrows the rubrics', async () => {
        const rows = await t.handle.db
          .selectFrom('session')
          .select(['id', 'flagged', 'sampled'])
          .execute();
        const eligible = rows.filter((r) => Boolean(r.flagged) || Boolean(r.sampled)).length;
        const summary = await grading.gradeNow({ since: new Date(0), policy: true });
        expect(summary.sessions).toBe(eligible);
        expect(summary.sessions).toBeGreaterThanOrEqual(1);
        await settings.update({ 'judge.sampling': 'every' });
        expect((await grading.gradeNow({ since: new Date(0), policy: true })).sessions).toBe(2);
      });
    });

    describe('budget', () => {
      it('defers to the next midnight when the daily token cap is used up, and records usage', async () => {
        await grading.gradeNow({ sessionIds: [codexId], policy: false });
        const used = await grading.budget.status();
        expect(used.tokensToday).toBeGreaterThan(0);
        await settings.update({ 'budget.tokens_per_day': 10 });

        const job = {
          id: newId(),
          payload: { sessionId: claudeId, rubricName: 'efficiency' },
        };
        const err = await grading.handlers[GRADE_SESSION_JOB]?.run(job as never).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(DeferJob);
        const runAfter = (err as DeferJob).runAfter;
        expect(runAfter.getTime()).toBeGreaterThan(Date.now());
        expect(runAfter.getHours()).toBe(0);
        expect(runAfter.getMinutes()).toBe(0);
        expect(runAfter.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
      });

      it('defers to the first of next month when the dollar ceiling is used up', async () => {
        await settings.update({ 'budget.mode': 'usd_month', 'budget.usd_per_month': 0 });
        const err = await grading.handlers[GRADE_SESSION_JOB]?.run({
          id: newId(),
          payload: { sessionId: claudeId, rubricName: 'efficiency' },
        } as never).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DeferJob);
        expect((err as DeferJob).runAfter.getDate()).toBe(1);
        expect(await gradeCount()).toBe(0);
      });

      it('ignores the dollar ceiling in tokens-only mode and queues deferred CLI work for later', async () => {
        await settings.update({
          'budget.mode': 'tokens_day',
          'budget.tokens_per_day': 10,
          'budget.usd_per_month': 0,
        });
        const summary = await grading.gradeNow({ sessionIds: [claudeId], policy: false });
        expect(summary).toMatchObject({ graded: 0, deferred: 4, failed: 0 });
        const waiting = await t.handle.db
          .selectFrom('job')
          .select('run_after')
          .where('kind', '=', GRADE_SESSION_JOB)
          .execute();
        expect(waiting).toHaveLength(4);
        expect(waiting.every((j) => Date.parse(j.run_after) > Date.now())).toBe(true);
      });

      it('refuses a dry run over budget with a 429-mapped error', async () => {
        await settings.update({ 'budget.tokens_per_day': 10 });
        await expect(grading.dryRun('efficiency', [claudeId])).rejects.toBeInstanceOf(
          BudgetExceededError,
        );
      });
    });

    describe('dry run', () => {
      it('grades an unsaved draft without persisting a grade, and compares with the human label', async () => {
        await grading.calibration.setLabel('efficiency', { sessionId: claudeId, passed: false });
        const result = await grading.dryRun('efficiency', [claudeId], {
          body: 'DRAFT BODY: judge only the number of failures.',
          passThreshold: 0.8,
        });
        expect(result.verdicts).toHaveLength(1);
        expect(result.verdicts[0]).toMatchObject({
          passed: false,
          humanPassed: false,
          agrees: true,
        });
        expect(result.usage.tokens).toBeGreaterThan(0);
        expect(await gradeCount()).toBe(0);
        const ledger = await t.handle.db.selectFrom('llm_call').select('purpose').execute();
        expect(ledger.map((l) => l.purpose)).toEqual(['dry_run']);
        await expect(
          grading.dryRun('efficiency', [claudeId], { passThreshold: 0.7 }),
        ).rejects.toThrow(/pass_threshold/);
      });
    });

    describe('calibration', () => {
      it('pins labelled sessions and reports judge against human', async () => {
        await grading.gradeNow({ sessionIds: [claudeId, codexId], policy: false });
        await grading.calibration.setLabel('efficiency', {
          sessionId: claudeId,
          passed: false,
          score: 0.2,
        });
        await grading.calibration.setLabel('efficiency', { sessionId: codexId, passed: false });
        const table = await grading.calibration.table('efficiency');
        expect(table).toMatchObject({ labelCount: 2, compared: 2, agreed: 1, trusted: false });
        expect(table?.rows.find((r) => r.sessionId === claudeId)).toMatchObject({
          agrees: true,
          human: { passed: false, score: 0.2 },
        });
        expect(table?.rows.find((r) => r.sessionId === codexId)?.agrees).toBe(false);
        const pinned = await t.handle.db
          .selectFrom('session')
          .select(['id', 'pinned'])
          .where('id', 'in', [claudeId, codexId])
          .execute();
        expect(pinned.every((s) => Boolean(s.pinned))).toBe(true);
        // PUT semantics: the same call again replaces the label.
        await grading.calibration.setLabel('efficiency', { sessionId: codexId, passed: true });
        expect((await grading.calibration.table('efficiency'))?.agreed).toBe(2);
        await expect(
          grading.calibration.setLabel('efficiency', {
            sessionId: codexId,
            passed: true,
            score: 0.3,
          }),
        ).rejects.toThrow(/score must be one of/);
      });

      it('marks a rubric trusted only at 8 of 10 agreeing labels and shows it on grades', async () => {
        const rubric = await rubrics.get('efficiency');
        if (!rubric) throw new Error('missing rubric');
        for (let i = 0; i < 10; i += 1) {
          const id = newId();
          await t.handle.db
            .insertInto('session')
            .values({
              id,
              workspace_id: LOCAL_WORKSPACE_ID,
              user_id: LOCAL_USER_ID,
              agent: 'claude_code',
              native_id: `n-${String(i)}`,
              status: 'ended',
              created_at: new Date().toISOString(),
            })
            .execute();
          await t.handle.db
            .insertInto('grade')
            .values({
              id: newId(),
              workspace_id: LOCAL_WORKSPACE_ID,
              session_id: id,
              rubric_id: rubric.id,
              rubric_version: rubric.version,
              score: 1,
              passed: true,
              reason: 'ok',
              evidence_event_ids: '[]',
              judge_model: 'fake-judge',
              transport: 'fake',
              graded_at: new Date().toISOString(),
            })
            .execute();
          // Eight humans agree (pass); two disagree.
          await grading.calibration.setLabel('efficiency', { sessionId: id, passed: i < 8 });
        }
        expect(await grading.calibration.table('efficiency')).toMatchObject({
          labelCount: 10,
          compared: 10,
          agreed: 8,
          trusted: true,
        });
        await grading.gradeNow({ sessionIds: [claudeId], policy: false });
        const grades = (await grading.sessions.get(claudeId))?.grades ?? [];
        expect(grades.find((g) => g.rubric === 'efficiency')?.trusted).toBe(true);
        expect(grades.find((g) => g.rubric === 'verbosity')?.trusted).toBe(false);
      });
    });

    describe('trends', () => {
      it('reports pass rate per rubric against the default or frontmatter target', async () => {
        await grading.gradeNow({ sessionIds: [claudeId, codexId], policy: false });
        const before = await grading.trendRubrics(new Date(0));
        expect(before.sessionsGraded).toBe(2);
        const efficiency = before.rubrics.find((r) => r.name === 'efficiency');
        expect(efficiency).toMatchObject({ passRate: 0.5, target: 0.7, gradedCount: 2 });
        await rubrics.update('efficiency', { target: 0.9 });
        expect(
          (await grading.trendRubrics(new Date(0))).rubrics.find((r) => r.name === 'efficiency')
            ?.target,
        ).toBe(0.9);
        expect(
          (await grading.trendRubrics(new Date(Date.now() + 86_400_000))).rubrics[0]?.passRate,
        ).toBeNull();
      });
    });
  });
}
