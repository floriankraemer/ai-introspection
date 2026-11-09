/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers are typed any */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../../platform/db/ids.js';
import { fromJson } from '../../platform/db/json.js';
import { BudgetExceededError } from '../../platform/errors.js';
import { initRepo } from '../../platform/git/index.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import { createJobQueue } from '../../platform/jobs/queue.js';
import { DeferJob } from '../../platform/jobs/worker.js';
import { writeFixtureSources } from '../../platform/testkit/agent-fixtures.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';
import { createIngest, REDACTION_VERSION, type IngestService } from '../ingest/index.js';
import { copyStarterRubrics, createRubrics, type RubricStore } from '../rubrics/index.js';
import { createSecretStore, createSettings, type SettingsService } from '../settings/index.js';
import {
  createFakeJudge,
  createGrading,
  GRADE_BATCH_JOB,
  GRADE_SESSION_JOB,
  type Grading,
} from './index.js';
import { STALE_RESERVATION_MS } from './budget.js';
import type { FakeDecision } from './judge-fake.js';
import { JudgeCallError, type Judge, type JudgeRequest, type Usage } from './types.js';

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
    let judgeCalls: JudgeRequest[];
    let activeJudge: Judge;
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
      judgeCalls = [];
      const judge = createFakeJudge((req) => {
        judgeCalls.push(req);
        if (decide) return decide(req);
        // The default rule of the fake judge, spelled out so the test can override it.
        const failed = [...req.trace.matchAll(/^\[(e\d+)\] \+\d+s \S+ ✕/gm)].map((m) => m[1] ?? '');
        return {
          score: failed.length >= 3 ? Math.min(...req.rubric.scale) : Math.max(...req.rubric.scale),
          reason: `${String(failed.length)} failed events`,
          evidence: failed.length > 0 ? failed.slice(0, 3) : ['e0'],
        };
      });
      activeJudge = judge;
      grading = createGrading({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        settings,
        queue: queue(),
        ingest,
        rubrics,
        judges: { current: () => Promise.resolve(activeJudge) },
        sweepDays: 36_500, // the fixture sessions are old
        timeZone: 'UTC',
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

    /** A redacted session of `n` plain events, for tests that need a particular size. */
    const insertSession = async (n: number): Promise<string> => {
      const id = newId();
      await t.handle.db
        .insertInto('session')
        .values({
          id,
          workspace_id: LOCAL_WORKSPACE_ID,
          user_id: LOCAL_USER_ID,
          agent: 'claude_code',
          native_id: id,
          status: 'ended',
          started_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          redaction_version: REDACTION_VERSION,
        })
        .execute();
      for (let i = 0; i < n; i += 1)
        await t.handle.db
          .insertInto('event')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            session_id: id,
            seq: i,
            kind: i % 2 === 0 ? 'user' : 'assistant',
            output: `message ${String(i)}`,
          })
          .execute();
      return id;
    };
    const ledger = () =>
      t.handle.db
        .selectFrom('llm_call')
        .select(['status', 'tokens_in', 'tokens_out', 'model'])
        .execute();

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

      it('needs evidence ids for every score, passing ones too, unless the session is tiny', async () => {
        decide = () => ({ score: 1, reason: 'fine', evidence: ['e99999'] });
        await grading.gradeNow({ sessionIds: [codexId], policy: false });
        const grades = (await grading.sessions.get(codexId))?.grades ?? [];
        expect(grades.every((g) => g.status === 'invalid' && g.passed === null)).toBe(true);
        expect(judgeCalls).toHaveLength(8); // each rubric asked once more

        // Two events: nothing to cite, so a verdict without evidence stands.
        const tiny = await insertSession(2);
        judgeCalls.length = 0;
        const summary = await grading.gradeNow({ sessionIds: [tiny], policy: false });
        expect(summary.graded).toBe(4);
        const tinyGrades = (await grading.sessions.get(tiny))?.grades ?? [];
        expect(tinyGrades.every((g) => g.status === 'ok' && g.passed === true)).toBe(true);
        expect(judgeCalls).toHaveLength(4);
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

    describe('redaction guard', () => {
      const setRedaction = (id: string, version: string) =>
        t.handle.db
          .updateTable('session')
          .set({ redaction_version: version })
          .where('id', '=', id)
          .execute();

      it('never sends a session that was stored unredacted or with old rules to the judge', async () => {
        const calls = () => judgeCalls.length;
        await setRedaction(claudeId, 'off');
        await setRedaction(codexId, '1');
        const summary = await grading.gradeNow({ sessionIds: [claudeId, codexId], policy: false });
        expect(summary).toMatchObject({ graded: 0, failed: 0 });
        expect(summary.skipped).toBe(8);
        expect(calls()).toBe(0);
        const listed = await grading.sessions.list({ limit: 50 });
        const reason = (id: string) => listed.items.find((s) => s.id === id)?.notGradedReason;
        expect(reason(claudeId)).toBe('redaction is off');
        expect(reason(codexId)).toBe('not redacted with current rules \u2014 re-import pending');
        expect(await grading.sweep()).toBe(0);
      });

      it('skips such a session in a dry run with the reason', async () => {
        await setRedaction(claudeId, 'off');
        const result = await grading.dryRun('efficiency', [claudeId]);
        expect(result.verdicts).toEqual([]);
        expect(result.skipped).toEqual([{ sessionId: claudeId, reason: 'redaction is off' }]);
        expect(judgeCalls).toHaveLength(0);
      });
    });

    describe('budget', () => {
      /** Puts `tokens` of earlier usage on today's ledger. */
      const spend = (tokens: number, usd = 0) =>
        t.handle.db
          .insertInto('llm_call')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            at: new Date().toISOString(),
            purpose: 'grade',
            model: 'claude-sonnet-5-5',
            transport: 'api',
            tokens_in: tokens,
            cost_estimate: usd,
          })
          .execute();

      it('defers to the next midnight when the daily token cap is used up, and records usage', async () => {
        await grading.gradeNow({ sessionIds: [codexId], policy: false });
        const used = await grading.budget.status();
        expect(used.tokensToday).toBeGreaterThan(0);
        await spend(149_000);
        await settings.update({ 'budget.tokens_per_day': 150_000 });

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
        expect(runAfter.getUTCHours()).toBe(0);
        expect(runAfter.getUTCMinutes()).toBe(0);
        expect(runAfter.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
      });

      it('defers to the first of next month when the dollar ceiling is used up', async () => {
        await spend(1, 0.99);
        await settings.update({ 'budget.mode': 'usd_month', 'budget.usd_per_month': 1 });
        const err = await grading.handlers[GRADE_SESSION_JOB]?.run({
          id: newId(),
          payload: { sessionId: claudeId, rubricName: 'efficiency' },
        } as never).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DeferJob);
        expect((err as DeferJob).runAfter.getUTCDate()).toBe(1);
        expect(await gradeCount()).toBe(0);
      });

      it('ignores the dollar ceiling in tokens-only mode and queues deferred CLI work for later', async () => {
        await spend(149_000);
        await settings.update({
          'budget.mode': 'tokens_day',
          'budget.tokens_per_day': 150_000,
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
        await spend(149_000);
        await settings.update({ 'budget.tokens_per_day': 150_000 });
        await expect(grading.dryRun('efficiency', [claudeId])).rejects.toBeInstanceOf(
          BudgetExceededError,
        );
      });

      it('fails a grade whose estimate is larger than the whole limit instead of deferring it for ever', async () => {
        await settings.update({ 'budget.tokens_per_day': 10 });
        const summary = await grading.gradeNow({ sessionIds: [claudeId], policy: false });
        expect(summary).toMatchObject({ graded: 0, deferred: 0, failed: 4 });
        expect(summary.errors[0]).toMatch(/more than the whole daily token budget of 10/);
        expect(await gradeCount()).toBe(0);
        expect(await ledger()).toEqual([]); // nothing was reserved or spent
        await expect(grading.dryRun('efficiency', [claudeId])).rejects.toThrow(
          /more than the whole daily token budget/,
        );
      });

      it('reserves the estimate before the call: parallel grades cannot overspend the limit', async () => {
        const slow = createFakeJudge(() => ({ score: 1, reason: 'fine', evidence: ['e0'] }));
        const big: Usage = { input: 2000, cacheRead: 0, cacheWrite: 0, output: 60 };
        activeJudge = {
          ...slow,
          async grade(req) {
            await new Promise((r) => setTimeout(r, 40)); // all four are in flight together
            return { ...(await slow.grade(req)), usage: big };
          },
        };
        // Room for about two estimates (about 2,300 tokens each) but not four.
        await settings.update({ 'budget.tokens_per_day': 5000 });
        const list = (await rubrics.list()).rubrics;
        const results = await Promise.allSettled(
          list.map((rubric) =>
            Promise.resolve(
              grading.handlers[GRADE_SESSION_JOB]?.run({
                id: newId(),
                payload: { sessionId: claudeId, rubricName: rubric.name },
              } as never),
            ),
          ),
        );
        const deferred = results.filter(
          (r) => r.status === 'rejected' && r.reason instanceof DeferJob,
        );
        expect(deferred.length).toBeGreaterThanOrEqual(1);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
        const status = await grading.budget.status();
        // Overspend is at most the gap between one call's estimate and its actual usage.
        expect(status.tokensToday).toBeLessThanOrEqual(5000 + 1000);
        expect((await ledger()).every((l) => l.status === 'ok')).toBe(true); // settled, none left reserved
        expect(await gradeCount()).toBe(results.length - deferred.length);
      });

      it('lets reservations that no process will settle expire', async () => {
        // A fixed morning, so the reservation and the check fall on the same budget day.
        const at = new Date('2026-11-09T01:00:00Z');
        await t.handle.db
          .insertInto('llm_call')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            at: at.toISOString(),
            purpose: 'grade',
            model: 'm',
            transport: 'api',
            tokens_in: 1_000_000,
            status: 'reserved',
          })
          .execute();
        const later = (ms: number) => new Date(at.getTime() + ms);
        expect(
          (await grading.budget.status(later(STALE_RESERVATION_MS - 60_000))).tokensToday,
        ).toBe(1_000_000);
        expect(
          (await grading.budget.status(later(STALE_RESERVATION_MS + 60_000))).tokensToday,
        ).toBe(0);
      });
    });

    describe('paid calls that give no verdict', () => {
      const unusable = (usage: Usage) =>
        new JudgeCallError(
          'The judge answered with something that is not a verdict',
          usage,
          'claude-sonnet-5-5',
          true,
        );
      const paid: Usage = { input: 300, cacheRead: 0, cacheWrite: 0, output: 50 };

      it('records every answered call on the ledger and counts bad answers against its own attempts', async () => {
        const grade = vi.fn(() => Promise.reject(unusable(paid)));
        activeJudge = { ...activeJudge, grade };
        const summary = await grading.gradeNow({ sessionIds: [codexId], policy: false });
        // Two tries per rubric, then an invalid grade: the job queue never sees a failure to retry.
        expect(summary).toMatchObject({ graded: 4, failed: 0 });
        expect(grade).toHaveBeenCalledTimes(8);
        const rows = await ledger();
        expect(rows).toHaveLength(8);
        expect(
          rows.every((r) => r.status === 'error' && r.tokens_in === 300 && r.tokens_out === 50),
        ).toBe(true);
        const grades = (await grading.sessions.get(codexId))?.grades ?? [];
        expect(grades).toHaveLength(4);
        expect(grades.every((g) => g.status === 'invalid' && g.passed === null)).toBe(true);
        expect(grades[0]?.reason).toMatch(/could not be used/);
        expect((await grading.budget.status()).tokensToday).toBe(8 * 350);
      });

      it('records a paid call that failed for another reason, then raises it; a call with no response leaves no row', async () => {
        activeJudge = {
          ...activeJudge,
          grade: () =>
            Promise.reject(new JudgeCallError('claude reported an error', paid, 'm', false)),
        };
        const failed = await grading.gradeNow({ sessionIds: [codexId], policy: false });
        expect(failed).toMatchObject({ graded: 0, failed: 4 });
        expect(await ledger()).toHaveLength(4);

        await t.handle.db.deleteFrom('llm_call').execute();
        activeJudge = {
          ...activeJudge,
          grade: () => Promise.reject(new Error('socket hang up')),
        };
        const offline = await grading.gradeNow({ sessionIds: [codexId], policy: false });
        expect(offline.failed).toBe(4);
        expect(await ledger()).toEqual([]);
      });
    });

    describe('stale grades', () => {
      it('shows a stale grade without a verdict, leaves it out of pass rates and grades it again', async () => {
        await grading.gradeNow({ sessionIds: [claudeId], policy: false });
        await t.handle.db.updateTable('grade').set({ status: 'stale' }).execute();

        const detail = await grading.sessions.get(claudeId);
        expect(detail?.grades.every((g) => g.status === 'stale')).toBe(true);
        const listed = (await grading.sessions.list({ limit: 50 })).items.find(
          (s) => s.id === claudeId,
        );
        expect(listed?.grades.every((g) => g.passed === null && g.score === null)).toBe(true);
        expect((await grading.trendRubrics(new Date(0))).sessionsGraded).toBe(0);
        const failedAny = await grading.sessions.list({ result: 'failed_any', limit: 50 });
        expect(failedAny.items).toEqual([]);

        // The sweep queues each stale grade once, whatever the sampling policy says, and the job replaces it.
        expect(await grading.sweep()).toBe(4);
        expect(await grading.sweep()).toBe(0);
        await runJobs();
        const again = await grading.sessions.get(claudeId);
        expect(again?.grades.map((g) => g.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
        expect(await gradeCount()).toBe(4);
        // Finished once; a second re-ingest that stales it again queues it again.
        await t.handle.db.updateTable('grade').set({ status: 'stale' }).execute();
        expect(await grading.sweep()).toBe(4);
      });
    });

    describe('judge model identity', () => {
      it('keys grades by the model asked for and keeps the one that answered', async () => {
        const inner = createFakeJudge(undefined, 'claude-fallback-9');
        activeJudge = { ...inner, model: 'claude-sonnet-5-5' };
        await grading.gradeNow({ sessionIds: [codexId], policy: false });
        const rows = await t.handle.db
          .selectFrom('grade')
          .select(['judge_model', 'answered_model'])
          .execute();
        expect(rows).toHaveLength(4);
        expect(
          rows.every(
            (r) =>
              r.judge_model === 'claude-sonnet-5-5' && r.answered_model === 'claude-fallback-9',
          ),
        ).toBe(true);
        const detail = (await grading.sessions.get(codexId))?.grades[0];
        expect(detail).toMatchObject({
          judgeModel: 'claude-sonnet-5-5',
          answeredModel: 'claude-fallback-9',
        });

        // Not graded again, although the answering model differs from the one asked for ...
        expect((await grading.gradeNow({ sessionIds: [codexId], policy: false })).skipped).toBe(4);
        // ... and a forced re-grade replaces the row instead of adding one.
        const id = await grading.enqueueBatch({ sessionIds: [codexId], force: true });
        const job = await queue().get(id);
        await grading.handlers[GRADE_BATCH_JOB]?.run({ id, payload: job?.payload } as never);
        expect(await gradeCount()).toBe(4);
      });
    });

    describe('reference re-grades', () => {
      const runBatch = async (input: Parameters<typeof grading.enqueueBatch>[0]) => {
        const id = await grading.enqueueBatch(input);
        const job = await queue().get(id);
        await grading.handlers[GRADE_BATCH_JOB]?.run({ id, payload: job?.payload } as never);
      };
      const rows = () =>
        t.handle.db.selectFrom('grade').select(['id', 'origin', 'judge_model']).execute();

      it('never replace a standard grade, are stored apart for a new judge model, and a standard grade replaces them', async () => {
        await grading.gradeNow({ sessionIds: [claudeId], policy: false });
        const standard = await rows();
        expect(standard.every((r) => r.origin === 'standard')).toBe(true);

        await runBatch({ sessionIds: [claudeId], force: true, origin: 'reference' });
        expect(await rows()).toEqual(standard); // same key: the standard grade stands

        activeJudge = { ...activeJudge, model: 'judge-b' };
        await runBatch({ sessionIds: [claudeId], force: true, origin: 'reference' });
        const after = await rows();
        expect(after).toHaveLength(standard.length * 2);
        expect(after.filter((r) => r.origin === 'reference').map((r) => r.judge_model)).toEqual(
          Array<string>(standard.length).fill('judge-b'),
        );

        await grading.gradeNow({ sessionIds: [claudeId], policy: false });
        const last = await rows();
        expect(last).toHaveLength(after.length);
        expect(last.every((r) => r.origin === 'standard')).toBe(true);
      });
    });

    describe('batch', () => {
      it('goes on after a session fails and reports each failure in the job progress', async () => {
        const claudeEvents = Number(
          (
            await t.handle.db
              .selectFrom('event')
              .select((eb) => eb.fn.countAll().as('n'))
              .where('session_id', '=', claudeId)
              .executeTakeFirstOrThrow()
          ).n,
        );
        decide = (req) => {
          if (req.eventCount === claudeEvents) throw new Error('judge exploded');
          return { score: 1, reason: 'fine', evidence: ['e0'] };
        };
        const id = await grading.enqueueBatch({ sessionIds: [claudeId, codexId], force: false });
        const job = await queue().get(id);
        await grading.handlers[GRADE_BATCH_JOB]?.run({ id, payload: job?.payload } as never);
        expect((await grading.sessions.get(codexId))?.grades).toHaveLength(4);
        expect((await grading.sessions.get(claudeId))?.grades).toHaveLength(0);
        const progress = (await queue().get(id))?.progress;
        expect(progress).toMatchObject({ failed: 1, done: 8, total: 8 });
        expect(progress?.errors?.[0]).toContain(`${claudeId}: judge exploded`);
      });
    });

    describe('budget windows', () => {
      it('follow the configured time zone', async () => {
        const tokyo = createGrading({
          db: t.handle.db,
          workspaceId: LOCAL_WORKSPACE_ID,
          userId: LOCAL_USER_ID,
          settings,
          queue: queue(),
          ingest,
          rubrics,
          judges: { current: () => Promise.resolve(activeJudge) },
          timeZone: 'Asia/Tokyo',
        });
        const status = await tokyo.budget.status(new Date('2026-03-10T20:00:00Z')); // 05:00 on the 11th in Tokyo
        expect(status.tokensResetAt).toBe('2026-03-11T15:00:00.000Z'); // 00:00 on the 12th, UTC+9
        expect(status.usdResetAt).toBe('2026-03-31T15:00:00.000Z'); // 00:00 on 1 April
        const utc = await grading.budget.status(new Date('2026-03-10T20:00:00Z'));
        expect(utc.tokensResetAt).toBe('2026-03-11T00:00:00.000Z');
      });
    });

    describe('sweep schedule', () => {
      it('runs every five minutes', async () => {
        expect(await grading.schedules[0]?.cron()).toBe('*/5 * * * *');
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
