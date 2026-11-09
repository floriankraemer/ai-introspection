/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers are typed any */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSkillRepos } from '../../modules/improvement/index.js';
import { createIngest } from '../../modules/ingest/index.js';
import { PLANTED, writeFixtureSources } from '../testkit/agent-fixtures.js';
import { createSecretStore, createSettings } from '../../modules/settings/index.js';
import { wireGrading, wireImprovement, wireTrends } from './wire-grading.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../identity/index.js';
import { createJobQueue } from '../jobs/queue.js';
import { createWorker } from '../jobs/worker.js';
import { sqliteTestDb, type TestDb } from '../testkit/db.js';
import { createApp } from './app.js';
import { loadOrCreateToken } from './auth.js';

const PORT = 7317;
const BASE = `http://127.0.0.1:${String(PORT)}`;

let t: TestDb;
let app: OpenAPIHono;
let token: string;
let dir: string;
let tick: () => Promise<void>;
let sources: ReturnType<typeof writeFixtureSources>;

const call = (method: string, path: string, body?: unknown) =>
  app.request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> =>
  (await res.json()) as T;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'introspect-api-'));
  mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web', 'index.html'), '<title>spa</title>');
  sources = writeFixtureSources(dir);
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
    candidates: [join(dir, 'repos', 'skills')],
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
  const improvement = wireImprovement({
    db: t.handle.db,
    ingest,
    settings,
    queue,
    skillRepos,
    grading,
    dataDir,
  });
  app = createApp({
    webDir: join(dir, 'web'),
    port: PORT,
    token,
    queue,
    settings,
    ingest,
    grading,
    improvement,
    rubrics,
    judges,
    trends: wireTrends({ db: t.handle.db, ingest, settings, skillRepos, grading, rubrics, judges }),
    skillRepos,
    doctor: () => Promise.resolve({ checks: [] }),
  });
});
afterAll(async () => {
  await t.destroy();
});

describe('sources and import', () => {
  it('rejects a source folder that does not exist with a 422 problem', async () => {
    const res = await call('POST', '/v1/sources', {
      agent: 'claude_code',
      path: join(dir, 'missing'),
    });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('registers sources and reports their watch status', async () => {
    expect(
      (await call('POST', '/v1/sources', { agent: 'claude_code', path: sources.claude })).status,
    ).toBe(200);
    await call('POST', '/v1/sources', { agent: 'codex', path: sources.codex });
    const list = await json<{ agent: string; status: string }[]>(await call('GET', '/v1/sources'));
    expect(list.map((s) => [s.agent, s.status])).toEqual([
      ['claude_code', 'polling'],
      ['codex', 'polling'],
    ]);
    expect(Array.isArray(await json(await call('GET', '/v1/sources/detected')))).toBe(true);
  });

  it('runs the import as a job with progress, and is idempotent', async () => {
    const accepted = await call('POST', '/v1/imports');
    expect(accepted.status).toBe(202);
    const job = await json<{ id: string; kind: string; status: string }>(accepted);
    expect(job).toMatchObject({ kind: 'import_history', status: 'queued' });
    await tick();
    expect(await json(await call('GET', `/v1/jobs/${job.id}`))).toMatchObject({
      status: 'succeeded',
      progress: { done: 2, total: 2 },
      error: null,
    });
    const first = await json<{ items: unknown[] }>(await call('GET', '/v1/sessions'));
    expect(first.items).toHaveLength(2);
    await call('POST', '/v1/imports');
    await tick();
    expect(
      (await json<{ items: unknown[] }>(await call('GET', '/v1/sessions'))).items,
    ).toHaveLength(2);
  });
});

describe('sessions', () => {
  const firstSession = async () =>
    (
      await json<{ items: { id: string; agent: string }[] }>(
        await call('GET', '/v1/sessions?agent=claude_code'),
      )
    ).items[0];

  it('lists sessions in the shape of the SPA contract', async () => {
    const page = await json<{ items: Record<string, unknown>[]; nextCursor: string | null }>(
      await call('GET', '/v1/sessions?limit=1'),
    );
    expect(page.nextCursor).not.toBeNull();
    expect(page.items[0]).toEqual({
      id: expect.any(String),
      title: expect.any(String),
      agent: expect.any(String),
      repo: expect.any(String),
      startedAt: expect.any(String),
      toolErrors: expect.any(Number),
      tokensIn: expect.any(Number),
      tokensOut: expect.any(Number),
      tokensCacheRead: expect.any(Number),
      tokensCacheWrite: expect.any(Number),
      grades: [],
      notGradedReason: expect.any(String),
    });
    expect((await call('GET', '/v1/sessions?limit=0')).status).toBe(400);
    expect((await call('GET', '/v1/sessions?since=yesterday')).status).toBe(400);
    const since = await json<{ items: unknown[] }>(
      await call('GET', '/v1/sessions?since=2099-01-01T00:00:00Z'),
    );
    expect(since.items).toEqual([]);
    expect(
      (
        await json<{ items: unknown[] }>(
          await call('GET', '/v1/sessions?since=2000-01-01T00:00:00Z'),
        )
      ).items,
    ).toHaveLength(2);
    expect((await call('GET', '/v1/sessions?agent=vim')).status).toBe(400);
  });

  it('returns detail, a filtered event page and 404 problems', async () => {
    const id = (await firstSession())?.id ?? '';
    const detail = await json(await call('GET', `/v1/sessions/${id}`));
    expect(detail).toMatchObject({
      agent: 'claude_code',
      eventCount: expect.any(Number),
      errorCount: 3,
      outcome: { kind: 'pr_open' },
    });
    const errors = await json<{ items: { isError: boolean }[]; total: number }>(
      await call('GET', `/v1/sessions/${id}/events?filter=errors&limit=100`),
    );
    expect(errors.total).toBe(3);
    expect(errors.items.every((e) => e.isError)).toBe(true);
    const missing = await call('GET', '/v1/sessions/018f0000-0000-7000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(
      (await call('GET', '/v1/sessions/018f0000-0000-7000-8000-000000000000/events')).status,
    ).toBe(404);
  });

  it('serves the raw source file and no event leaks a planted secret', async () => {
    const id = (await firstSession())?.id ?? '';
    const raw = await call('GET', `/v1/sessions/${id}/raw`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe(readFileSync(sources.claudeFile, 'utf8'));
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect(raw.headers.get('content-disposition')).toBe('inline');
    expect(raw.headers.get('content-type')).toContain('text/plain');
    const events = JSON.stringify(
      await json(await call('GET', `/v1/sessions/${id}/events?limit=500`)),
    );
    for (const secret of PLANTED) expect(events).not.toContain(secret);
  });

  it('refuses a raw file that is no longer inside a registered source', async () => {
    const id = (await firstSession())?.id ?? '';
    const outside = join(dir, 'outside.jsonl');
    writeFileSync(outside, 'private');
    await t.handle.db
      .updateTable('ingest_cursor')
      .set({ file_path: outside })
      .where('session_id', '=', id)
      .execute();
    expect((await call('GET', `/v1/sessions/${id}/raw`)).status).toBe(404);
    await t.handle.db
      .updateTable('ingest_cursor')
      .set({ file_path: sources.claudeFile })
      .where('session_id', '=', id)
      .execute();
    expect((await call('GET', `/v1/sessions/${id}/raw`)).status).toBe(200);
  });

  it('summarizes the trends header', async () => {
    expect(await json(await call('GET', '/v1/trends/summary?days=365'))).toEqual({
      days: 365,
      sessionsCollected: 2,
      sessionsGraded: 0,
      rubrics: [],
    });
    expect(await json(await call('GET', '/v1/trends/summary'))).toMatchObject({ days: 7 });
    expect(await json(await call('GET', '/v1/trends/summary?days=0'))).toMatchObject({
      days: 0,
      sessionsCollected: 2,
    });
    expect((await call('GET', '/v1/trends/summary?days=366')).status).toBe(400);
    expect((await call('GET', '/v1/trends/summary?days=-1')).status).toBe(400);
  });
});

describe('settings and judge key', () => {
  it('stores the judge key write-only in a 0600 file', async () => {
    const secret = 'sk-ant-this-must-never-come-back';
    expect((await call('PUT', '/v1/settings/judge-key', { apiKey: secret })).status).toBe(204);
    const settings = await json(await call('GET', '/v1/settings'));
    expect(settings['judge.api_key_set']).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(secret);
    expect(statSync(join(dir, 'data', 'secrets')).mode & 0o777).toBe(0o600);
    expect((await call('PATCH', '/v1/settings', { 'judge.api_key_set': false })).status).toBe(400);
    expect((await call('PUT', '/v1/settings/judge-key', { apiKey: 'x' })).status).toBe(400);
  });

  it('accepts the SPA settings keys', async () => {
    const res = await call('PATCH', '/v1/settings', {
      'setup.completed': true,
      'redaction.enabled': true,
      'judge.transport': 'cli',
      'budget.mode': 'usd_month',
      'budget.usd_per_month': 20,
      'schedule.grade': 'pr_merge',
      'proposals.accept_mode': 'pr',
    });
    expect(await json(res)).toMatchObject({
      'setup.completed': true,
      'judge.transport': 'cli',
      'proposals.accept_mode': 'pr',
    });
  });

  it('tests the judge transport (a fake judge in this suite)', async () => {
    expect(await json(await call('POST', '/v1/judge/test', { transport: 'api' }))).toEqual({
      ok: true,
      detail: 'Fake judge (test only)',
    });
  });
});

describe('skill repos', () => {
  let repo: string;
  beforeAll(() => {
    repo = join(dir, 'skills');
    mkdirSync(repo);
    git(repo, 'init', '-q');
  });

  it('refuses a folder that is not a git repository with a 422 problem', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const res = await call('PUT', '/v1/skill-repos/global', { path: plain });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      status: 422,
      detail: expect.stringContaining('git repository'),
    });
    expect((await call('PUT', '/v1/skill-repos/global', { path: 'relative' })).status).toBe(422);
  });

  it('needs a global repo before copying rubrics', async () => {
    expect((await call('POST', '/v1/skill-repos/global/starter-rubrics')).status).toBe(409);
  });

  it('registers the repo and copies the four starter rubrics in one commit, skipping existing files', async () => {
    const put = await json<{ id: string; hasRubrics: boolean; kind: string }>(
      await call('PUT', '/v1/skill-repos/global', { path: repo }),
    );
    expect(put).toMatchObject({ kind: 'global', hasRubrics: false, enabled: true });
    mkdirSync(join(repo, 'rubrics'));
    writeFileSync(join(repo, 'rubrics', 'verbosity.md'), 'mine');
    const res = await json<{ copied: string[] }>(
      await call('POST', '/v1/skill-repos/global/starter-rubrics'),
    );
    expect(res.copied.sort()).toEqual(['efficiency', 'redundant-tests', 'silent-workaround']);
    expect(readFileSync(join(repo, 'rubrics', 'verbosity.md'), 'utf8')).toBe('mine');
    expect(existsSync(join(repo, 'rubrics', 'efficiency.md'))).toBe(true);
    expect(git(repo, 'log', '--oneline')).toContain('starter rubrics');
    expect(git(repo, 'status', '--porcelain')).toContain('verbosity.md'); // untouched, still the user's file
    expect(
      (
        await json<{ copied: string[] }>(
          await call('POST', '/v1/skill-repos/global/starter-rubrics'),
        )
      ).copied,
    ).toEqual([]);
    const list = await json<{ hasRubrics: boolean }[]>(await call('GET', '/v1/skill-repos'));
    expect(list).toHaveLength(1);
    expect(list[0]?.hasRubrics).toBe(true);
  });

  it('disables a repo', async () => {
    const [repoRow] = await json<{ id: string }[]>(await call('GET', '/v1/skill-repos'));
    expect(
      await json(await call('PATCH', `/v1/skill-repos/${repoRow?.id ?? ''}`, { enabled: false })),
    ).toMatchObject({ enabled: false });
    expect(
      (
        await call('PATCH', '/v1/skill-repos/018f0000-0000-7000-8000-000000000000', {
          enabled: true,
        })
      ).status,
    ).toBe(404);
  });
});

describe('initialising the global skills repository', () => {
  let root: string;
  beforeAll(() => {
    root = join(dir, 'repos');
    mkdirSync(root);
  });
  const init = (path: string) => call('POST', '/v1/skill-repos/global/init', { path });

  it('reports a missing or empty mount as empty, not as a repository', async () => {
    expect(await json(await call('GET', '/v1/skill-repos/detected'))).toEqual([]);
    mkdirSync(join(root, 'skills'));
    expect(await json(await call('GET', '/v1/skill-repos/detected'))).toEqual([
      { path: join(root, 'skills'), isGitRepo: false, hasRubrics: false, isEmpty: true },
    ]);
  });

  it('refuses paths outside the mounted roots, relative paths and folders with content', async () => {
    expect((await init(join(dir, 'elsewhere'))).status).toBe(422);
    expect((await init(`${root}/../escape`)).status).toBe(422);
    expect((await init('relative')).status).toBe(422);
    symlinkSync(tmpdir(), join(root, 'link'));
    expect((await init(join(root, 'link', 'x'))).status).toBe(422);
    const busy = join(root, 'busy');
    mkdirSync(busy);
    writeFileSync(join(busy, '.hidden'), 'mine');
    expect((await init(busy)).status).toBe(409);
    expect(readdirSync(busy)).toEqual(['.hidden']);
  });

  it('creates a git repository on main with the starter rubrics in one commit, and registers it', async () => {
    const target = join(root, 'skills');
    const res = await init(target);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ kind: 'global', path: target, hasRubrics: true });
    expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(target, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(target, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(target, 'rubrics', 'efficiency.md'))).toBe(true);
    expect((await init(target)).status).toBe(409);
    expect(await json(await call('GET', '/v1/skill-repos/detected'))).toEqual([
      { path: target, isGitRepo: true, hasRubrics: true, isEmpty: false },
    ]);
  });

  it('creates a missing folder under the root', async () => {
    const target = join(root, 'new', 'deep');
    expect((await init(target)).status).toBe(200);
    expect(existsSync(join(target, '.git'))).toBe(true);
  });
});
