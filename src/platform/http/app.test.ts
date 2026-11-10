import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSkillRepos } from '../../modules/improvement/index.js';
import { createIngest } from '../../modules/ingest/index.js';
import { createSecretStore, createSettings } from '../../modules/settings/index.js';
import { wireGrading, wireImprovement, wireTrends } from './wire-grading.js';
import { newId } from '../db/ids.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../identity/index.js';
import { hashIntakeToken } from '../identity/tokens.js';
import { createJobQueue } from '../jobs/queue.js';
import { sqliteTestDb, type TestDb } from '../testkit/db.js';
import { createApp, OPENAPI_INFO } from './app.js';
import {
  loadOrCreateToken,
  requireToken,
  rotateToken,
  TOKEN_COOKIE,
  tokenMatches,
  tokenReader,
} from './auth.js';

const PORT = 7317;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const CONTRACT_FILE = new URL('../../../docs/api/openapi.json', import.meta.url);

let t: TestDb;
let app: OpenAPIHono;
let token: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'introspect-app-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
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
    pollMode: false,
  });
  const skillRepos = createSkillRepos(t.handle.db, LOCAL_WORKSPACE_ID);
  const { grading, rubrics, judges } = wireGrading({
    db: t.handle.db,
    ingest,
    settings,
    queue,
    skillRepos,
  });
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
    webDir: dir,
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
    doctor: () =>
      Promise.resolve({
        checks: [{ id: 'x', label: 'X', status: 'ok' as const, detail: 'fine', fix: null }],
      }),
  });
});
afterAll(async () => {
  await t.destroy();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`${BASE}${path}`, { headers });
const bearer = () => ({ authorization: `Bearer ${token}` });

describe('open endpoints', () => {
  it('reports health without a token', async () => {
    const res = await get('/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves the OpenAPI 3.1 contract without a token', async () => {
    const res = await get('/v1/openapi.json');
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/jobs/{id}');
  });

  it('matches the checked-in contract (run with UPDATE_OPENAPI=1 to accept a change)', () => {
    const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: OPENAPI_INFO });
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI) writeFileSync(CONTRACT_FILE, text);
    expect(text).toBe(readFileSync(CONTRACT_FILE, 'utf8'));
  });
});

describe('local token auth', () => {
  it('rejects an authed endpoint without a token as problem+json', async () => {
    const res = await get('/v1/settings');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ title: 'Unauthorized', status: 401 });
  });

  it('rejects a wrong token, including on unknown /v1 paths', async () => {
    expect((await get('/v1/settings', { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await get('/v1/does-not-exist')).status).toBe(401);
  });

  it('rejects a personal intake token: those work on the intake port only', async () => {
    const intakeToken = 'itk_main-api-check';
    const at = new Date().toISOString();
    await t.handle.db
      .insertInto('api_token')
      .values({
        id: newId(),
        workspace_id: LOCAL_WORKSPACE_ID,
        user_id: LOCAL_USER_ID,
        name: 'main-api-check',
        token_hash: hashIntakeToken(intakeToken),
        created_at: at,
        expires_at: null,
        revoked_at: null,
      })
      .execute();
    expect((await get('/v1/settings', { authorization: `Bearer ${intakeToken}` })).status).toBe(
      401,
    );
  });

  it('accepts the bearer token', async () => {
    const res = await get('/v1/settings', bearer());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ 'retention.days': 90, 'judge.api_key_set': false });
  });

  it('exchanges the token for an HttpOnly SameSite=Strict cookie that authenticates', async () => {
    const bad = await app.request(`${BASE}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ token: 'wrong' }),
    });
    expect(bad.status).toBe(401);

    const res = await app.request(`${BASE}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const authed = await get('/v1/settings', { cookie: cookie.split(';')[0] ?? '' });
    expect(authed.status).toBe(200);
  });

  it('refuses a Host that is not loopback (DNS rebinding)', async () => {
    const res = await app.request('http://evil.example:7317/v1/health');
    expect(res.status).toBe(403);
  });

  it('refuses a foreign Origin even with a valid token', async () => {
    const res = await get('/v1/settings', { ...bearer(), origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
});

describe('browser hardening', () => {
  const post = (headers: Record<string, string>, body = '{}') =>
    app.request(`${BASE}/v1/settings`, { method: 'PATCH', headers, body });
  const json = { 'content-type': 'application/json' };

  it('sends a strict CSP and the other security headers', async () => {
    const res = await get('/v1/health');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('allows only the hash of the sign-in script inline, on /auth', async () => {
    const res = await get('/auth');
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'sha256-[\w+/=]+'/);
  });

  it.each(['/auth', '/auth/', '//auth', '/auth//'])('uses the sign-in CSP on %s', async (path) => {
    const res = await get(path);
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'sha256-[\w+/=]+'/);
  });

  it('refuses a cookie-authenticated change without Origin or Sec-Fetch-Site', async () => {
    const cookie = `${TOKEN_COOKIE}=${token}`;
    expect((await post({ ...json, cookie })).status).toBe(403);
    expect((await post({ ...json, cookie, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await post({ ...json, cookie, origin: BASE })).status).toBe(200);
  });

  it('lets the bearer token change things without Origin', async () => {
    expect((await post({ ...json, ...bearer() })).status).toBe(200);
  });

  it('requires a JSON content type on bodies', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', ''])
      expect(
        (await post({ ...bearer(), ...(type && { 'content-type': type }), 'content-length': '2' }))
          .status,
      ).toBe(415);
  });
});

describe('token rotation', () => {
  it('signs out old cookies and bearer tokens of a running server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'introspect-rot-'));
    const read = tokenReader(dir);
    const old = read();
    const guarded = new Hono()
      .use('*', requireToken(read, new Set()))
      .get('/', (c) => c.text('ok'));
    const call = (t: string) => guarded.request('/', { headers: { authorization: `Bearer ${t}` } });
    expect((await call(old)).status).toBe(200);
    const fresh = rotateToken(dir);
    expect(fresh).not.toBe(old);
    expect((await call(old)).status).toBe(401);
    expect((await call(fresh)).status).toBe(200);
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
  });

  it('keeps the old token when the file is briefly empty or short, or unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'introspect-rot-'));
    const read = tokenReader(dir);
    const old = read();
    const file = join(dir, 'token');
    writeFileSync(file, '');
    expect(read()).toBe(old);
    writeFileSync(file, 'abc\n');
    expect(read()).toBe(old);
    rmSync(file);
    expect(read()).toBe(old);
    const fresh = 'f'.repeat(old.length);
    writeFileSync(file, `${fresh}\n`);
    expect(read()).toBe(fresh);
  });

  it('never matches an empty candidate', () => {
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches('a'.repeat(64), '')).toBe(false);
  });

  it('keeps the session cookie for 30 days', async () => {
    const res = await app.request(`${BASE}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ token }),
    });
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=2592000/);
  });
});

describe('api behaviour', () => {
  it('returns problem+json with field errors for invalid input', async () => {
    const res = await app.request(`${BASE}/v1/settings`, {
      method: 'PATCH',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ 'retention.days': 1 }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as { errors: { path: string }[] };
    expect(body.errors[0]?.path).toContain('retention.days');
  });

  it('updates settings', async () => {
    const res = await app.request(`${BASE}/v1/settings`, {
      method: 'PATCH',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ 'schedule.improver': 'weekly' }),
    });
    expect(await res.json()).toMatchObject({ 'schedule.improver': 'weekly' });
  });

  it('serves the doctor report and the detected skill repos behind the token', async () => {
    expect((await get('/v1/doctor')).status).toBe(401);
    const doctor = await get('/v1/doctor', bearer());
    expect(await doctor.json()).toEqual({
      checks: [{ id: 'x', label: 'X', status: 'ok', detail: 'fine', fix: null }],
    });
    const detected = await get('/v1/skill-repos/detected', bearer());
    expect(detected.status).toBe(200);
    expect(Array.isArray(await detected.json())).toBe(true);
  });

  it('lists jobs and answers 404 problem+json for a missing job', async () => {
    const list = await get('/v1/jobs?limit=5', bearer());
    expect(await list.json()).toEqual({ items: [], nextCursor: null });
    const missing = await get('/v1/jobs/018f0000-0000-7000-8000-000000000000', bearer());
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/problem+json');
  });
});

describe('trends api', () => {
  const post = (path: string, method = 'POST') =>
    app.request(`${BASE}${path}`, { method, headers: bearer() });

  it('serves the series with one bucket per week and all markers lists', async () => {
    const res = await get('/v1/trends?weeks=4&bucket=week', bearer());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      buckets: unknown[];
      markers: unknown[];
      baselineResets: unknown[];
    };
    expect(body.buckets).toHaveLength(4);
    expect(body.markers).toEqual([]);
    expect(body.baselineResets).toEqual([]);
    expect(
      ((await (await get('/v1/trends', bearer())).json()) as { buckets: unknown[] }).buckets,
    ).toHaveLength(12);
  });

  it('refuses a range that is not 4, 12 or 26 weeks', async () => {
    expect((await get('/v1/trends?weeks=5', bearer())).status).toBe(400);
    expect((await get('/v1/trends?bucket=month', bearer())).status).toBe(400);
  });

  it('serves the change log and the reference set, empty at first', async () => {
    expect(await (await get('/v1/trends/changes', bearer())).json()).toEqual([]);
    expect(await (await get('/v1/trends/reference', bearer())).json()).toEqual({
      target: 20,
      items: [],
    });
  });

  it('starts a change scan now: 202 and a trends_scan job, a new one each time', async () => {
    const first = await post('/v1/trends/scan');
    expect(first.status).toBe(202);
    const a = (await first.json()) as { id: string; kind: string };
    expect(a.kind).toBe('trends_scan');
    const b = (await (await post('/v1/trends/scan')).json()) as { id: string };
    expect(b.id).not.toBe(a.id);
    expect(
      (await app.request(`${BASE}/v1/trends/scan`, { method: 'POST', headers: { origin: BASE } }))
        .status,
    ).toBe(401);
  });

  it('answers 409 to a re-grade of an empty reference set and 404 to an unknown session', async () => {
    expect((await post('/v1/trends/reference-regrade')).status).toBe(409);
    const missing = '018f0000-0000-7000-8000-000000000000';
    expect((await post(`/v1/sessions/${missing}/reference`)).status).toBe(404);
    expect((await post(`/v1/sessions/${missing}/reference`, 'DELETE')).status).toBe(404);
  });
});

describe('SPA and token file', () => {
  it('serves the SPA at / and for client-side routes, and the sign-in page', async () => {
    for (const path of ['/', '/sessions/42']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>spa</title>');
    }
    expect(await (await get('/auth')).text()).toContain('location.hash');
  });

  it('keeps the token file private and stable across restarts', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'introspect-tok-')), 'data');
    const first = loadOrCreateToken(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateToken(dir)).toBe(first);
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
  });
});
