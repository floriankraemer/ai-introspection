/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/restrict-template-expressions -- JSON bodies of an API under test are untyped */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSkillRepos } from '../../modules/improvement/index.js';
import { createIngest } from '../../modules/ingest/index.js';
import { createSecretStore, createSettings } from '../../modules/settings/index.js';
import { createTrends } from '../../modules/trends/index.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../identity/index.js';
import { createJobQueue } from '../jobs/queue.js';
import { createWorker } from '../jobs/worker.js';
import { writeFixtureSources } from '../testkit/agent-fixtures.js';
import { sqliteTestDb, type TestDb } from '../testkit/db.js';
import { wireGrading } from './wire-grading.js';
import { createApp } from './app.js';
import { loadOrCreateToken } from './auth.js';

const PORT = 7317;
const BASE = `http://127.0.0.1:${String(PORT)}`;
let t: TestDb;
let app: OpenAPIHono;
let token: string;
let tick: () => Promise<void>;
let claudeId: string;

const call = (method: string, path: string, body?: unknown) =>
  app.request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T = any>(res: Response): Promise<T> => (await res.json()) as T;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'introspect-grading-api-'));
  mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<title>spa</title>');
  const sources = writeFixtureSources(dir);
  t = await sqliteTestDb();
  const dataDir = join(dir, 'data');
  token = loadOrCreateToken(dataDir);
  const queue = createJobQueue(t.handle);
  const settings = createSettings(t.handle.db, LOCAL_WORKSPACE_ID, createSecretStore(dataDir));
  const ingest = createIngest({
    db: t.handle.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    userId: LOCAL_USER_ID,
    dataDir,
    settings,
    queue,
    pollMode: true,
  });
  const skillRepos = createSkillRepos(t.handle.db, LOCAL_WORKSPACE_ID, {
    mountRoots: [join(dir, 'repos')],
  });
  const { grading, rubrics, judges } = wireGrading({
    db: t.handle.db,
    ingest,
    settings,
    queue,
    skillRepos,
  });
  const worker = createWorker({ queue, handlers: { ...ingest.handlers, ...grading.handlers } });
  tick = () => worker.tick();
  app = createApp({
    webDir: join(dir, 'web'),
    port: PORT,
    token,
    queue,
    settings,
    ingest,
    grading,
    rubrics,
    judges,
    trends: createTrends(ingest, grading),
    skillRepos,
    doctor: () => Promise.resolve({ checks: [] }),
  });
  await ingest.sources.add('claude_code', sources.claude);
  await ingest.importAll();
  claudeId = (await ingest.sessions.list({ limit: 10, agent: 'claude_code' })).items[0]?.id ?? '';
  mkdirSync(join(dir, 'repos', 'skills'), { recursive: true });
  await call('POST', '/v1/skill-repos/global/init', { path: join(dir, 'repos', 'skills') });
});
afterAll(async () => {
  await t.destroy();
});

describe('rubric API', () => {
  it('lists the starter rubrics with gate state and edits one through a commit', async () => {
    const list = await json<{ name: string; version: number; trusted: boolean }[]>(
      await call('GET', '/v1/rubrics'),
    );
    expect(list.map((r) => r.name)).toEqual([
      'efficiency',
      'redundant-tests',
      'silent-workaround',
      'verbosity',
    ]);
    expect(list[0]).toMatchObject({
      version: 1,
      trusted: false,
      agreement: { agree: 0, total: 0 },
    });

    const put = await call('PUT', '/v1/rubrics/efficiency', {
      body: 'New body.\n\n- 1.0 ok\n- 0.0 bad',
      passThreshold: 0.8,
      message: 'raise the bar',
    });
    expect(put.status).toBe(200);
    const detail = await json(put);
    expect(detail).toMatchObject({ name: 'efficiency', version: 2, passThreshold: 0.8 });
    expect(detail.versions.map((v: { message: string }) => v.message)).toEqual([
      'raise the bar',
      'chore(rubrics): add Introspect starter rubrics',
    ]);
    expect((await call('GET', '/v1/rubrics/nope')).status).toBe(404);
    expect((await call('PUT', '/v1/rubrics/efficiency', { passThreshold: 0.33 })).status).toBe(422);
  });

  it('creates a rubric from a whole file', async () => {
    const file =
      '---\nname: tidy\nscale: [0.0, 1.0]\npass_threshold: 1.0\napplies_to: all\n---\nIs it tidy?';
    expect((await call('PUT', '/v1/rubrics/tidy', { body: file })).status).toBe(200);
    expect(await json(await call('GET', '/v1/rubrics/tidy'))).toMatchObject({ scale: [0, 1] });
  });
});

describe('grading API', () => {
  it('queues a batch, grades through the worker and shows grades on the session', async () => {
    const res = await call('POST', '/v1/grades/batch', { sessionIds: [claudeId] });
    expect(res.status).toBe(202);
    const job = await json(res);
    expect(job).toMatchObject({ kind: 'grade_batch', status: 'queued' });
    await tick();
    expect((await json(await call('GET', `/v1/jobs/${job.id}`))).status).toBe('succeeded');

    const detail = await json(await call('GET', `/v1/sessions/${claudeId}`));
    expect(detail.grades.length).toBeGreaterThanOrEqual(4);
    expect(detail.grades[0]).toMatchObject({
      rubric: expect.any(String),
      rubricVersion: expect.any(Number),
      transport: 'fake',
      trusted: false,
      judgeModel: 'fake-judge',
    });
    const list = await json(await call('GET', '/v1/sessions?result=failed_any'));
    expect(list.items[0].grades.length).toBeGreaterThanOrEqual(4);
    const evidence = await json(
      await call('GET', `/v1/sessions/${claudeId}/events?filter=evidence`),
    );
    expect(evidence.total).toBeGreaterThan(0);
    const summary = await json(await call('GET', '/v1/trends/summary?days=365'));
    expect(summary.sessionsGraded).toBe(1);
    expect(summary.rubrics[0]).toMatchObject({ target: 0.7, passRate: 0 });
  });

  it('re-grades one session, and 404s for an unknown one', async () => {
    expect((await call('POST', `/v1/sessions/${claudeId}/grade`)).status).toBe(202);
    expect(
      (await call('POST', '/v1/sessions/018f0000-0000-7000-8000-000000000000/grade')).status,
    ).toBe(404);
  });

  it('labels a session, shows the calibration table and dry-runs a draft', async () => {
    expect(
      (
        await call('POST', '/v1/rubrics/verbosity/labels', {
          sessionId: claudeId,
          passed: true,
          note: 'fine',
        })
      ).status,
    ).toBe(204);
    expect(
      (await call('PUT', '/v1/rubrics/verbosity/labels', { sessionId: claudeId, passed: false }))
        .status,
    ).toBe(204);
    const table = await json(await call('GET', '/v1/rubrics/verbosity/calibration'));
    expect(table).toMatchObject({ labelCount: 1, trusted: false, required: { labels: 10 } });
    expect(table.rows[0]).toMatchObject({
      human: { passed: false },
      judge: { passed: false },
      agrees: true,
    });

    const dry = await call('POST', '/v1/rubrics/verbosity/dry-run', {
      sessionIds: [claudeId],
      body: 'Draft: be strict.',
    });
    expect(dry.status).toBe(200);
    expect(await json(dry)).toMatchObject({ verdicts: [{ sessionId: claudeId, agrees: true }] });
  });

  it('reports the budget, tests the judge and answers 429 for a dry run over budget', async () => {
    expect(await json(await call('GET', '/v1/budget'))).toMatchObject({
      mode: 'tokens_day',
      tokensPerDay: 1_000_000,
      usdPerMonth: null,
    });
    expect(await json(await call('POST', '/v1/judge/test', { transport: 'api' }))).toEqual({
      ok: true,
      detail: 'Fake judge (test only)',
    });
    await call('PATCH', '/v1/settings', { 'budget.tokens_per_day': 10 });
    const over = await call('POST', '/v1/rubrics/verbosity/dry-run', { sessionIds: [claudeId] });
    expect(over.status).toBe(429);
    expect(over.headers.get('content-type')).toContain('application/problem+json');
    // A batch over budget is deferred, with the reason in the job's error.
    const job = await json(
      await call('POST', '/v1/grades/batch', { sessionIds: [claudeId], force: true }),
    );
    await tick(); // the re-grade queued by an earlier test
    await tick();
    expect(await json(await call('GET', `/v1/jobs/${job.id}`))).toMatchObject({
      status: 'deferred',
      error: expect.stringContaining('daily token budget'),
    });
  });
});
