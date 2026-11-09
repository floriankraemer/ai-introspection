import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSettings } from '../../modules/settings/index.js';
import { LOCAL_WORKSPACE_ID } from '../identity/index.js';
import { createJobQueue } from '../jobs/queue.js';
import { sqliteTestDb, type TestDb } from '../testkit/db.js';
import { createApp, OPENAPI_INFO } from './app.js';
import { loadOrCreateToken } from './auth.js';

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
  token = loadOrCreateToken(join(dir, 'data'));
  app = createApp({
    webDir: dir,
    port: PORT,
    token,
    queue: createJobQueue(t.handle),
    settings: createSettings(t.handle.db, LOCAL_WORKSPACE_ID),
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

  it('accepts the bearer token', async () => {
    const res = await get('/v1/settings', bearer());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ retention: { payload_days: 90 } });
  });

  it('exchanges the token for an HttpOnly SameSite=Strict cookie that authenticates', async () => {
    const bad = await app.request(`${BASE}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

describe('api behaviour', () => {
  it('returns problem+json with field errors for invalid input', async () => {
    const res = await app.request(`${BASE}/v1/settings`, {
      method: 'PATCH',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ retention: { payload_days: 1 } }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as { errors: { path: string }[] };
    expect(body.errors[0]?.path).toContain('payload_days');
  });

  it('updates settings', async () => {
    const res = await app.request(`${BASE}/v1/settings`, {
      method: 'PATCH',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: JSON.stringify({ improver: { schedule: 'weekly' } }),
    });
    expect(await res.json()).toMatchObject({ improver: { schedule: 'weekly' } });
  });

  it('lists jobs and answers 404 problem+json for a missing job', async () => {
    const list = await get('/v1/jobs?limit=5', bearer());
    expect(await list.json()).toEqual({ items: [], next_cursor: null });
    const missing = await get('/v1/jobs/018f0000-0000-7000-8000-000000000000', bearer());
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/problem+json');
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
