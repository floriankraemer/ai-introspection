import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSkillRepos } from '../../modules/improvement/index.js';
import { createIngest } from '../../modules/ingest/index.js';
import { createSecretStore, createSettings } from '../../modules/settings/index.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../identity/index.js';
import { findIntakeToken } from '../identity/tokens.js';
import { createJobQueue } from '../jobs/queue.js';
import { sqliteTestDb, type TestDb } from '../testkit/db.js';
import { createApp } from './app.js';
import { loadOrCreateToken } from './auth.js';
import { wireGrading, wireImprovement, wireTrends } from './wire-grading.js';

const PORT = 7317;
const BASE = `http://127.0.0.1:${String(PORT)}`;

let t: TestDb;
let app: OpenAPIHono;
let token: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'introspect-intake-tokens-'));
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
    intakeTokens: { db: t.handle.db, port: 7318 },
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
    doctor: () => Promise.resolve({ checks: [] }),
  });
});
afterAll(async () => {
  await t.destroy();
});

const call = (method: string, path: string, body?: unknown, auth = true) =>
  app.request(`${BASE}${path}`, {
    method,
    headers: {
      ...(auth && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('intake token routes', () => {
  it('creates a token whose plaintext is returned once and never listed', async () => {
    const res = await call('POST', '/v1/intake-tokens', { name: ' Ada ', expiresInDays: 30 });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const created = await json(res);
    expect(created).toMatchObject({ name: 'Ada', person: 'Ada', revokedAt: null });
    expect(typeof created.token).toBe('string');
    expect(created.expiresAt).not.toBeNull();

    const list = await json(await call('GET', '/v1/intake-tokens'));
    expect(list.intake).toEqual({ port: 7318 });
    const tokens = list.tokens as Record<string, unknown>[];
    expect(tokens.map((r) => r.id)).toContain(created.id);
    const text = JSON.stringify(list);
    expect(text).not.toContain(created.token as string);
    expect(text).not.toMatch(/hash/i);
  });

  it("answers 409 for a taken name unless samePerson, and 422 for the owner's name", async () => {
    await call('POST', '/v1/intake-tokens', { name: 'Grace' });
    const taken = await call('POST', '/v1/intake-tokens', { name: 'Grace' });
    expect(taken.status).toBe(409);
    expect((await json(taken)).detail).toContain('already has a token');
    const same = await call('POST', '/v1/intake-tokens', { name: 'Grace', samePerson: true });
    expect(same.status).toBe(201);
    const owner = await t.handle.db
      .selectFrom('app_user')
      .select('display_name')
      .where('id', '=', LOCAL_USER_ID)
      .executeTakeFirstOrThrow();
    const res = await call('POST', '/v1/intake-tokens', {
      name: owner.display_name,
      samePerson: true,
    });
    expect(res.status).toBe(422);
  });

  it('validates the body', async () => {
    for (const body of [{ name: '  ' }, { name: 'x', expiresInDays: 0 }, { name: 'x'.repeat(65) }])
      expect((await call('POST', '/v1/intake-tokens', body)).status).toBe(400);
  });

  it('revokes by id: the token stops working, a second revoke and unknown ids are 404', async () => {
    const created = await json(await call('POST', '/v1/intake-tokens', { name: 'Linus' }));
    const plain = created.token as string;
    expect(await findIntakeToken(t.handle.db, LOCAL_WORKSPACE_ID, plain)).not.toBeNull();
    expect((await call('DELETE', `/v1/intake-tokens/${String(created.id)}`)).status).toBe(204);
    expect(await findIntakeToken(t.handle.db, LOCAL_WORKSPACE_ID, plain)).toBeNull();
    expect((await call('DELETE', `/v1/intake-tokens/${String(created.id)}`)).status).toBe(404);
    expect(
      (await call('DELETE', '/v1/intake-tokens/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
  });

  it('revokes only the token with that id, never one named like it', async () => {
    const target = await json(await call('POST', '/v1/intake-tokens', { name: 'Barbara' }));
    const squatter = await json(
      await call('POST', '/v1/intake-tokens', { name: String(target.id) }),
    );
    expect((await call('DELETE', `/v1/intake-tokens/${String(target.id)}`)).status).toBe(204);
    expect(
      await findIntakeToken(t.handle.db, LOCAL_WORKSPACE_ID, squatter.token as string),
    ).not.toBeNull();
  });

  it('needs the admin token', async () => {
    expect((await call('GET', '/v1/intake-tokens', undefined, false)).status).toBe(401);
    // Unauthenticated writes are refused by the CSRF guard (403) before the token check (401).
    expect([401, 403]).toContain(
      (await call('POST', '/v1/intake-tokens', { name: 'x' }, false)).status,
    );
    expect([401, 403]).toContain(
      (await call('DELETE', '/v1/intake-tokens/x', undefined, false)).status,
    );
    const foreign = await app.request('http://evil.example/v1/intake-tokens', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(foreign.status).toBe(403);
  });
});
