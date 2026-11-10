import { serve } from '@hono/node-server';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../platform/db/connection.js';
import { sessionId } from '../../platform/db/ids.js';
import { migrateToLatest } from '../../platform/db/migrate.js';
import { fromJson } from '../../platform/db/json.js';
import { createIntakeApp } from '../../platform/http/intake-app.js';
import { ensureLocalIdentity, LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import { createIntakeToken } from '../../platform/identity/intake-tokens.js';
import { createJobQueue } from '../../platform/jobs/queue.js';
import {
  CLAUDE_SESSION_ID,
  PLANTED,
  writeFixtureSources,
} from '../../platform/testkit/agent-fixtures.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';
import { createSecretStore, createSettings } from '../settings/index.js';
import { createIngest, type IngestService } from './index.js';
import { runPush, type PushOptions } from './push.js';

export function pushSuite(name: string, make: TestDbFactory): void {
  describe(`introspect push (${name})`, () => {
    let t: TestDb;
    let dir: string;
    let ingest: IngestService;
    let server: ReturnType<typeof serve>;
    let url: string;
    let token: string;
    let claude: string;
    let claudeFile: string;
    let codex: string;
    const db = () => t.handle.db;
    const sid = sessionId('claude_code', CLAUDE_SESSION_ID);

    const push = (over: Partial<PushOptions> = {}) =>
      runPush({
        server: url,
        token,
        redact: false,
        dirs: [{ agent: 'claude_code', path: claude }],
        dryRun: false,
        insecure: false,
        dataDir: join(dir, 'client'),
        databaseUrl: join(dir, 'client', 'introspect.db'),
        ...over,
      });

    /** Runs the queued ingest jobs the way the worker would. */
    const drain = async (): Promise<void> => {
      const jobs = await db().selectFrom('job').select(['id', 'payload']).execute();
      for (const j of jobs) {
        await ingest.handlers.ingest_file?.run({ payload: fromJson(j.payload) } as never);
        await db().deleteFrom('job').where('id', '=', j.id).execute();
      }
    };

    beforeEach(async () => {
      t = await make();
      dir = mkdtempSync(join(tmpdir(), 'introspect-push-'));
      ({ claude, claudeFile, codex } = writeFixtureSources(join(dir, 'home')));
      const dataDir = join(dir, 'data');
      ingest = createIngest({
        db: db(),
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: 'local',
        dataDir,
        settings: createSettings(db(), LOCAL_WORKSPACE_ID, createSecretStore(dataDir)),
        queue: createJobQueue(t.handle),
        pollMode: false,
      });
      const app = createIntakeApp({
        db: db(),
        workspaceId: LOCAL_WORKSPACE_ID,
        intake: ingest.intake,
        maxBytes: 10 * 1024 * 1024,
        quotaBytes: 100 * 1024 * 1024,
      });
      server = await new Promise((resolve) => {
        const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => {
          resolve(s);
        });
      });
      url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      token = (await createIntakeToken(db(), 'alice')).token;
    });
    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
      await t.destroy();
      rmSync(dir, { recursive: true, force: true });
    });

    const owner = async () =>
      (
        await db()
          .selectFrom('session')
          .innerJoin('app_user', 'app_user.id', 'session.user_id')
          .select(['app_user.display_name', 'session.status'])
          .where('session.id', '=', sid)
          .executeTakeFirstOrThrow()
      ).display_name;

    it('pushes a raw log for the token user, and a second run does nothing', async () => {
      expect(await push()).toMatchObject({ pushed: 1, unchanged: 0, failed: 0 });
      await drain();
      expect(await owner()).toBe('alice');
      expect(statSync(join(dir, 'client', 'push-state.json')).mode & 0o777).toBe(0o600);
      expect(await push()).toMatchObject({ pushed: 0, unchanged: 1, failed: 0 });
    });

    it('pushes a file again once it has grown', async () => {
      await push();
      const before = statSync(claudeFile).mtime;
      appendFileSync(claudeFile, '\n');
      utimesSync(claudeFile, new Date(before.getTime() + 5000), new Date(before.getTime() + 5000));
      expect(await push()).toMatchObject({ pushed: 1, unchanged: 0 });
    });

    it('--redact stores a redacted session that has no cursor', async () => {
      expect(await push({ redact: true })).toMatchObject({ pushed: 1, failed: 0 });
      expect(await owner()).toBe('alice');
      const stored = JSON.stringify(
        await db()
          .selectFrom('event')
          .select(['input', 'output'])
          .where('session_id', '=', sid)
          .execute(),
      );
      expect(stored.length).toBeGreaterThan(10);
      for (const secret of PLANTED) expect(stored).not.toContain(secret);
      const cursors = await db().selectFrom('ingest_cursor').select('file_path').execute();
      expect(cursors).toEqual([]);
      const row = await db()
        .selectFrom('session')
        .select('status')
        .where('id', '=', sid)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('ended'); // the fixture went quiet long ago
      expect(
        Object.keys(
          JSON.parse(readFileSync(join(dir, 'client', 'push-state.json'), 'utf8')) as object,
        ),
      ).toEqual([url]);
    });

    const storedText = async () =>
      JSON.stringify(
        await db()
          .selectFrom('event')
          .select(['input', 'output'])
          .where('session_id', '=', sid)
          .execute(),
      );

    it('--redact applies the custom patterns of the pusher’s own database, and refuses when it is unreadable', async () => {
      const client = join(dir, 'client');
      const local = join(client, 'introspect.db');
      mkdirSync(client, { recursive: true });
      const handle = openDatabase(local);
      await migrateToLatest(handle);
      await ensureLocalIdentity(handle.db);
      await createSettings(handle.db, LOCAL_WORKSPACE_ID, createSecretStore(client)).update({
        'redaction.custom_patterns': ['build passes'],
      });
      await handle.close();

      const lines: string[] = [];
      expect(await push({ redact: true, log: (l) => lines.push(l) })).toMatchObject({
        pushed: 1,
        failed: 0,
      });
      const stored = await storedText();
      expect(stored).toContain('Done. The');
      expect(stored).not.toContain('build passes');
      expect(lines.join('\n')).not.toMatch(/default rules/);

      for (const f of [local, `${local}-wal`, `${local}-shm`]) rmSync(f, { force: true });
      writeFileSync(local, 'not a database');
      await expect(push({ redact: true, dataDir: join(dir, 'client2') })).rejects.toThrow(
        /local Introspect database/,
      );
    });

    it('--redact without a local database says it uses the default rules', async () => {
      const lines: string[] = [];
      expect(await push({ redact: true, log: (l) => lines.push(l) })).toMatchObject({ pushed: 1 });
      expect(lines.join('\n')).toMatch(/default rules/);
      expect(await storedText()).toContain('build passes');
    });

    it('never follows a redirect, which could carry the token and the session elsewhere', async () => {
      const redirector = createServer((req, res) => {
        res.writeHead(307, { location: `${url}${req.url ?? '/'}` }).end();
      });
      await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
      try {
        const via = `http://127.0.0.1:${String((redirector.address() as AddressInfo).port)}`;
        for (const redact of [true, false])
          expect(await push({ server: via, redact })).toMatchObject({ pushed: 0, failed: 1 });
        expect(await db().selectFrom('session').select('id').execute()).toEqual([]);
        await drain();
        expect(await db().selectFrom('session').select('id').execute()).toEqual([]);
      } finally {
        await new Promise((resolve) => redirector.close(resolve));
      }
    });

    it('reports a raw push of a session pushed redacted as failed, with a hint, and stores nothing', async () => {
      expect(await push({ redact: true })).toMatchObject({ pushed: 1, failed: 0 });
      const raw = await push();
      expect(raw).toMatchObject({ pushed: 0, failed: 1 });
      expect(raw.errors[0]).toMatch(/409.*other mode/);
      expect(await db().selectFrom('ingest_cursor').select('file_path').execute()).toEqual([]);
      expect(await db().selectFrom('job').select('id').execute()).toEqual([]);
    });

    it('reports a redacted push of a session pushed raw as failed, with a hint', async () => {
      expect(await push()).toMatchObject({ pushed: 1, failed: 0 });
      await drain();
      const redacted = await push({ redact: true });
      expect(redacted).toMatchObject({ pushed: 0, failed: 1 });
      expect(redacted.errors[0]).toMatch(/409.*other mode/);
      // Back to raw: nothing changed since the raw push.
      expect(await push()).toMatchObject({ pushed: 0, unchanged: 1, failed: 0 });
    });

    it('does not push an unchanged raw log again just because it went quiet', async () => {
      const mtime = statSync(claudeFile).mtimeMs;
      expect(await push({ now: () => new Date(mtime + 1000) })).toMatchObject({ pushed: 1 });
      expect(await push({ now: () => new Date(mtime + 3600_000) })).toMatchObject({
        pushed: 0,
        unchanged: 1,
      });
    });

    it('keeps what a push running alongside wrote to the state file', async () => {
      const stateFile = join(dir, 'client', 'push-state.json');
      let wroteOther = false;
      const s = await push({
        dirs: [
          { agent: 'claude_code', path: claude },
          { agent: 'codex', path: codex },
        ],
        log: () => {
          if (wroteOther) return;
          wroteOther = true;
          const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
          writeFileSync(stateFile, JSON.stringify({ ...state, 'https://other.example': {} }));
        },
      });
      expect(s).toMatchObject({ pushed: 2, failed: 0 });
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, object>;
      expect(Object.keys(state).sort()).toEqual(['https://other.example', url].sort());
      expect(Object.keys(state[url] ?? {})).toHaveLength(2);
    });

    it('refuses plain http to a remote host unless told to', async () => {
      await expect(push({ server: 'http://intake.example:7318' })).rejects.toThrow(/plain http/);
    });

    it('fails with the problem detail when the token is wrong', async () => {
      const s = await push({ token: 'nope' });
      expect(s).toMatchObject({ pushed: 0, failed: 1 });
      expect(s.errors[0]).toMatch(/401/);
    });
  });
}
