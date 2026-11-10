import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIngest } from '../../modules/ingest/index.js';
import { createSecretStore, createSettings } from '../../modules/settings/index.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../identity/index.js';
import { createJobQueue } from '../jobs/queue.js';
import { sqliteTestDb, type TestDb } from '../testkit/db.js';
import { createIntakeApp, INTAKE_OPENAPI_INFO } from './intake-app.js';

const BASE = 'http://intake.example:7318';
const CONTRACT_FILE = new URL('../../../docs/api/intake-openapi.json', import.meta.url);

let t: TestDb;
let dir: string;
let app: ReturnType<typeof createIntakeApp>;

beforeAll(async () => {
  t = await sqliteTestDb();
  dir = mkdtempSync(join(tmpdir(), 'introspect-intake-app-'));
  const dataDir = join(dir, 'data');
  const ingest = createIngest({
    db: t.handle.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    userId: LOCAL_USER_ID,
    dataDir,
    settings: createSettings(t.handle.db, LOCAL_WORKSPACE_ID, createSecretStore(dataDir)),
    queue: createJobQueue(t.handle),
    pollMode: false,
  });
  app = createIntakeApp({
    db: t.handle.db,
    workspaceId: LOCAL_WORKSPACE_ID,
    intake: ingest.intake,
    maxBytes: 1024,
    quotaBytes: 1024 * 1024,
  });
});
afterAll(async () => {
  await t.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe('intake app', () => {
  it('answers health on any Host, with secure headers and no token', async () => {
    const res = await app.request(`${BASE}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves nothing of the main API or the SPA', async () => {
    for (const path of ['/v1/settings', '/v1/sessions', '/', '/auth', '/index.html']) {
      const res = await app.request(`${BASE}${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
    }
  });

  it('asks for a token before it says whether an intake path exists', async () => {
    expect((await app.request(`${BASE}/v1/intake/nope`, { method: 'PUT' })).status).toBe(401);
  });

  it('matches the checked-in contract (run with UPDATE_OPENAPI=1 to accept a change)', async () => {
    const served = (await (await app.request(`${BASE}/v1/openapi.json`)).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(served.paths).sort()).toEqual([
      '/v1/health',
      '/v1/intake/logs/{agent}/{path}',
      '/v1/intake/sessions/{id}',
    ]);
    const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: INTAKE_OPENAPI_INFO });
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI) writeFileSync(CONTRACT_FILE, text);
    expect(text).toBe(readFileSync(CONTRACT_FILE, 'utf8'));
  });
});
