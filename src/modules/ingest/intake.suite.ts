import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, sessionId } from '../../platform/db/ids.js';
import { fromJson } from '../../platform/db/json.js';
import { createIntakeApp } from '../../platform/http/intake-app.js';
import { loadOrCreateToken } from '../../platform/http/auth.js';
import { LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import { hashIntakeToken } from '../../platform/identity/tokens.js';
import { createJobQueue } from '../../platform/jobs/queue.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';
import {
  CLAUDE_SESSION_ID,
  claudeSessionLines,
  PLANTED,
  SECRETS,
} from '../../platform/testkit/agent-fixtures.js';
import { createSecretStore, createSettings } from '../settings/index.js';
import { createIngest, REDACTION_VERSION, type IngestService } from './index.js';

const BASE = 'http://intake.example:7318';
const CAP = 64 * 1024;
const QUOTA = 1024 * 1024;
/** Larger than any disk: the free-space check refuses every raw upload, and only the session cap applies. */
const HUGE = 2 ** 50;
/** The fixture session went quiet at this time (see agent-fixtures.ts). */
const QUIET_MS = Date.parse('2026-10-01T11:00:00.000Z');
const CLAUDE_PATH = `-work-demo/${CLAUDE_SESSION_ID}.jsonl`;

interface Person {
  userId: string;
  token: string;
}

export function intakeSuite(name: string, make: TestDbFactory): void {
  describe(`intake (${name})`, () => {
    let t: TestDb;
    let dir: string;
    let dataDir: string;
    let ingest: IngestService;
    let app: ReturnType<typeof createIntakeApp>;
    let alice: Person;
    let bob: Person;

    const db = () => t.handle.db;

    const person = async (
      display: string,
      token: Partial<{ revoked: boolean; expired: boolean }> = {},
    ): Promise<Person> => {
      const userId = newId();
      const plain = `itk_${display}_${newId()}`;
      const at = new Date().toISOString();
      await db()
        .insertInto('app_user')
        .values({
          id: userId,
          workspace_id: LOCAL_WORKSPACE_ID,
          display_name: display,
          email: null,
          role: 'member',
          created_at: at,
        })
        .execute();
      await db()
        .insertInto('api_token')
        .values({
          id: newId(),
          workspace_id: LOCAL_WORKSPACE_ID,
          user_id: userId,
          name: display,
          token_hash: hashIntakeToken(plain),
          created_at: at,
          expires_at: token.expired ? '2020-01-01T00:00:00.000Z' : null,
          revoked_at: token.revoked ? at : null,
        })
        .execute();
      return { userId, token: plain };
    };

    const putLog = (
      who: Person | string | null,
      agent: string,
      path: string,
      body: string | Buffer,
      headers: Record<string, string> = {},
    ) =>
      app.request(`${BASE}/v1/intake/logs/${agent}/${path}`, {
        method: 'PUT',
        headers: {
          ...(who !== null && {
            authorization: `Bearer ${typeof who === 'string' ? who : who.token}`,
          }),
          'content-type': 'application/x-ndjson',
          'x-introspect-mtime': String(QUIET_MS),
          ...headers,
        },
        body: typeof body === 'string' ? body : new Uint8Array(body),
      });

    const putSession = (
      who: Person,
      id: string,
      body: unknown,
      headers: Record<string, string> = {},
      on = app,
    ) =>
      on.request(`${BASE}/v1/intake/sessions/${id}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${who.token}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: Buffer.isBuffer(body)
          ? new Uint8Array(body)
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
      });

    /** Runs the queued ingest jobs the way the worker would, then forgets them. */
    const drain = async (): Promise<void> => {
      const jobs = await db()
        .selectFrom('job')
        .select(['id', 'payload'])
        .where('kind', '=', 'ingest_file')
        .execute();
      for (const j of jobs) {
        await ingest.handlers.ingest_file?.run({ payload: fromJson(j.payload) } as never);
        await db().deleteFrom('job').where('id', '=', j.id).execute();
      }
    };

    const appWith = (limits: { maxBytes: number; quotaBytes: number }) =>
      createIntakeApp({
        db: db(),
        workspaceId: LOCAL_WORKSPACE_ID,
        intake: ingest.intake,
        ...limits,
      });

    const lines = (n?: number): string => `${claudeSessionLines().slice(0, n).join('\n')}\n`;
    const intakeDir = (p: Person, agent = 'claude_code') =>
      join(dataDir, 'intake', p.userId, agent);
    const eventsOf = (sid: string) =>
      db()
        .selectFrom('event')
        .select(['id', 'seq', 'source_key', 'input', 'output', 'name'])
        .where('session_id', '=', sid)
        .orderBy('seq')
        .execute();

    const trace = (over: Record<string, unknown> = {}) => ({
      agent: 'claude_code',
      nativeId: 'pushed-1',
      adapterVersion: '1',
      redactionVersion: REDACTION_VERSION,
      ended: false,
      session: {
        title: 'Fix the build',
        cwd: '/home/bob/demo',
        repo: 'demo',
        branch: 'main',
        model: 'claude-opus-5-5',
        startedAt: '2026-10-01T10:00:00Z',
        endedAt: '2026-10-01T10:05:00Z',
        tokensIn: 3,
        tokensOut: 4,
        tokensCacheRead: 5,
        tokensCacheWrite: 6,
        outcomeKind: 'none',
      },
      events: [
        {
          seq: 0,
          ts: '2026-10-01T10:00:00Z',
          kind: 'user',
          output: 'please fix it',
          sourceKey: 'a:0',
        },
        {
          seq: 1,
          ts: '2026-10-01T10:01:00Z',
          kind: 'tool_call',
          name: 'bash',
          input: JSON.stringify({ command: `export GITHUB_TOKEN=${SECRETS.github}` }),
          output: 'ok',
          callId: 'toolu_1',
          sourceKey: 'b:0',
        },
      ],
      ...over,
    });
    const pushedId = sessionId('claude_code', 'pushed-1');

    beforeEach(async () => {
      t = await make();
      dir = mkdtempSync(join(tmpdir(), 'introspect-intake-'));
      dataDir = join(dir, 'data');
      const settings = createSettings(db(), LOCAL_WORKSPACE_ID, createSecretStore(dataDir));
      ingest = createIngest({
        db: db(),
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: newId(),
        dataDir,
        settings,
        queue: createJobQueue(t.handle),
        pollMode: false,
      });
      app = createIntakeApp({
        db: db(),
        workspaceId: LOCAL_WORKSPACE_ID,
        intake: ingest.intake,
        maxBytes: CAP,
        quotaBytes: QUOTA,
      });
      alice = await person('alice');
      bob = await person('bob');
    });
    afterEach(async () => {
      await t.destroy();
      rmSync(dir, { recursive: true, force: true });
    });

    describe('raw logs', () => {
      it('stores the file privately, registers the person as a source and ingests as them', async () => {
        const res = await putLog(alice, 'claude_code', CLAUDE_PATH, lines());
        expect(res.status).toBe(202);
        const sid = sessionId('claude_code', CLAUDE_SESSION_ID);
        expect(await res.json()).toEqual({ sessionId: sid, jobQueued: true });

        const file = join(intakeDir(alice), CLAUDE_PATH);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(join(intakeDir(alice), '-work-demo')).mode & 0o777).toBe(0o700);
        expect(statSync(intakeDir(alice)).mode & 0o777).toBe(0o700);
        expect(Math.floor(statSync(file).mtimeMs)).toBe(QUIET_MS);

        const source = await db()
          .selectFrom('source')
          .selectAll()
          .where('kind', '=', 'intake')
          .executeTakeFirstOrThrow();
        expect(source).toMatchObject({ agent: 'claude_code', user_id: alice.userId });

        await drain();
        const session = await db()
          .selectFrom('session')
          .selectAll()
          .where('id', '=', sid)
          .executeTakeFirstOrThrow();
        expect(session).toMatchObject({
          user_id: alice.userId,
          redaction_version: REDACTION_VERSION,
          status: 'ended',
        });
        const stored = JSON.stringify(await eventsOf(sid));
        for (const secret of PLANTED) expect(stored).not.toContain(secret);
      });

      it('accepts gzip and ingests only the new lines when a grown file is pushed again', async () => {
        const sid = sessionId('claude_code', CLAUDE_SESSION_ID);
        const gz = { 'content-encoding': 'gzip' };
        expect(
          (await putLog(alice, 'claude_code', CLAUDE_PATH, gzipSync(lines(8)), gz)).status,
        ).toBe(202);
        await drain();
        const first = await eventsOf(sid);
        expect(first.length).toBeGreaterThan(0);

        expect(
          (await putLog(alice, 'claude_code', CLAUDE_PATH, gzipSync(lines()), gz)).status,
        ).toBe(202);
        await drain();
        const all = await eventsOf(sid);
        expect(all.length).toBeGreaterThan(first.length);
        // Appended, not rebuilt: the events of the first push keep their rows.
        expect(all.slice(0, first.length).map((e) => e.id)).toEqual(first.map((e) => e.id));

        // The same bytes again change nothing.
        await putLog(alice, 'claude_code', CLAUDE_PATH, lines());
        await drain();
        expect((await eventsOf(sid)).map((e) => e.id)).toEqual(all.map((e) => e.id));
      });

      it.each([
        ['a traversal', 'claude_code', `..%2F..%2F..%2Fescape%2F${CLAUDE_SESSION_ID}.jsonl`],
        [
          'a traversal inside the project',
          'claude_code',
          `-work-demo%2F..%2F${CLAUDE_SESSION_ID}.jsonl`,
        ],
        ['an absolute path', 'claude_code', `%2Fetc%2F${CLAUDE_SESSION_ID}.jsonl`],
        ['a hidden folder', 'claude_code', `.ssh/${CLAUDE_SESSION_ID}.jsonl`],
        ['a control character', 'claude_code', `-work-demo/a%00b.jsonl`],
        ['an unknown agent', 'gemini', CLAUDE_PATH],
        ['a path the agent does not write', 'claude_code', '-work-demo/notes.md'],
        [
          'a subagent transcript',
          'claude_code',
          `-work-demo/${CLAUDE_SESSION_ID}/subagents/agent-1.jsonl`,
        ],
      ])('refuses %s with 422 and writes nothing', async (_what, agent, path) => {
        const res = await putLog(alice, agent, path, lines());
        expect(res.status).toBe(422);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
        expect(existsSync(join(dataDir, 'escape'))).toBe(false);
        expect(existsSync(join(dataDir, 'intake', alice.userId, 'escape'))).toBe(false);
        expect(await db().selectFrom('source').select('id').execute()).toEqual([]);
      });

      it('refuses a path that a symlink would lead out of the person’s folder', async () => {
        const outside = join(dir, 'outside');
        mkdirSync(outside);
        mkdirSync(intakeDir(alice), { recursive: true });
        symlinkSync(outside, join(intakeDir(alice), 'evil'));
        const res = await putLog(alice, 'claude_code', `evil/${CLAUDE_SESSION_ID}.jsonl`, lines());
        expect(res.status).toBe(422);
        expect(readdirSync(outside)).toEqual([]);
      });

      it.each([
        ['no token', null],
        ['a wrong token', 'itk_nope'],
      ])('answers 401 to %s', async (_what, token) => {
        const res = await putLog(token, 'claude_code', CLAUDE_PATH, lines());
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
      });

      it('answers 401 to a revoked, an expired and the local admin token', async () => {
        const revoked = await person('carol', { revoked: true });
        const expired = await person('dave', { expired: true });
        for (const who of [revoked.token, expired.token, loadOrCreateToken(dataDir)])
          expect((await putLog(who, 'claude_code', CLAUDE_PATH, lines())).status).toBe(401);
        expect(existsSync(join(dataDir, 'intake'))).toBe(false);
      });

      it('answers 413 to a gzip bomb and to a large plain body, leaving no file behind', async () => {
        const bomb = gzipSync(Buffer.alloc(CAP * 64, 'a'));
        expect(bomb.length).toBeLessThan(CAP);
        const res = await putLog(alice, 'claude_code', CLAUDE_PATH, bomb, {
          'content-encoding': 'gzip',
        });
        expect(res.status).toBe(413);
        expect((await putLog(alice, 'claude_code', CLAUDE_PATH, 'x'.repeat(CAP + 1))).status).toBe(
          413,
        );
        expect(existsSync(join(intakeDir(alice), CLAUDE_PATH))).toBe(false);
        expect(readdirSync(join(dataDir, 'intake', '.tmp'))).toEqual([]);
      });

      it('answers 507 when the disk would keep less than the upload cap plus a reserve free', async () => {
        const res = await appWith({ maxBytes: HUGE, quotaBytes: HUGE }).request(
          `${BASE}/v1/intake/logs/claude_code/${CLAUDE_PATH}`,
          {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${alice.token}`,
              'content-type': 'application/x-ndjson',
            },
            body: lines(),
          },
        );
        expect(res.status).toBe(507);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
        expect(existsSync(join(intakeDir(alice), CLAUDE_PATH))).toBe(false);
      });

      it('answers 507 once a person’s files reach the quota; a replaced file and other people do not count', async () => {
        const size = Buffer.byteLength(lines());
        const small = appWith({ maxBytes: CAP, quotaBytes: size + 10 });
        const put = (who: Person, path: string) =>
          small.request(`${BASE}/v1/intake/logs/claude_code/${path}`, {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${who.token}`,
              'content-type': 'application/x-ndjson',
            },
            body: lines(),
          });
        expect((await put(alice, CLAUDE_PATH)).status).toBe(202);
        expect((await put(alice, CLAUDE_PATH)).status).toBe(202);
        const over = await put(alice, `-work-other/${CLAUDE_SESSION_ID}.jsonl`);
        expect(over.status).toBe(507);
        expect(((await over.json()) as { detail: string }).detail).toMatch(/quota/);
        expect(existsSync(join(intakeDir(alice), '-work-other'))).toBe(true);
        expect(readdirSync(join(intakeDir(alice), '-work-other'))).toEqual([]);
        expect(readdirSync(join(dataDir, 'intake', '.tmp'))).toEqual([]);
        expect((await put(bob, CLAUDE_PATH)).status).toBe(202);
      });

      it('does not let parallel uploads by one person pass the quota together', async () => {
        const size = Buffer.byteLength(lines());
        const small = appWith({ maxBytes: CAP, quotaBytes: size + 10 });
        const statuses = await Promise.all(
          ['-a', '-b', '-c'].map(async (project) => {
            const res = await small.request(
              `${BASE}/v1/intake/logs/claude_code/${project}/${CLAUDE_SESSION_ID}-${project}.jsonl`,
              {
                method: 'PUT',
                headers: {
                  authorization: `Bearer ${alice.token}`,
                  'content-type': 'application/x-ndjson',
                },
                body: lines(),
              },
            );
            return res.status;
          }),
        );
        expect(statuses.sort()).toEqual([202, 507, 507]);
      });

      it('answers 422 to a body that is not gzip and 415 to another content type', async () => {
        expect(
          (await putLog(alice, 'claude_code', CLAUDE_PATH, 'plain', { 'content-encoding': 'gzip' }))
            .status,
        ).toBe(422);
        expect(
          (
            await putLog(alice, 'claude_code', CLAUDE_PATH, lines(), {
              'content-type': 'text/plain',
            })
          ).status,
        ).toBe(415);
        expect(
          (await putLog(alice, 'claude_code', CLAUDE_PATH, lines(), { 'content-encoding': 'br' }))
            .status,
        ).toBe(415);
        expect(
          (
            await putLog(alice, 'claude_code', CLAUDE_PATH, lines(), {
              'x-introspect-mtime': 'yesterday',
            })
          ).status,
        ).toBe(400);
      });
    });

    describe('client-redacted sessions', () => {
      it('stores the session for the pusher and redacts it again on the server', async () => {
        const plain = await putSession(bob, pushedId, trace());
        expect(plain.status).toBe(200);
        expect(await plain.json()).toEqual({ sessionId: pushedId, events: 2 });
        const session = await db()
          .selectFrom('session')
          .selectAll()
          .where('id', '=', pushedId)
          .executeTakeFirstOrThrow();
        expect(session).toMatchObject({
          user_id: bob.userId,
          redaction_version: REDACTION_VERSION,
          repo_root: null,
          repo: 'demo',
          status: 'active',
          tokens_cache_write: 6,
          ended_at: '2026-10-01T10:05:00.000Z',
        });
        const events = await eventsOf(pushedId);
        expect(JSON.stringify(events)).not.toContain(SECRETS.github);
        expect(events[1]?.input).toContain('[REDACTED:');
        expect(await db().selectFrom('ingest_cursor').select('file_path').execute()).toEqual([]);
      });

      it('finalizes a quiet pushed session that has no end time', async () => {
        const open = trace();
        open.session = { ...open.session, endedAt: null } as never;
        expect((await putSession(bob, pushedId, open)).status).toBe(200);
        await ingest.reconcile();
        const row = await db()
          .selectFrom('session')
          .select('status')
          .where('id', '=', pushedId)
          .executeTakeFirstOrThrow();
        expect(row.status).toBe('ended');
      });

      it('takes a gzip body and finalizes an ended session', async () => {
        const res = await putSession(
          bob,
          pushedId,
          gzipSync(JSON.stringify(trace({ ended: true }))),
          {
            'content-encoding': 'gzip',
          },
        );
        expect(res.status).toBe(200);
        const session = await db()
          .selectFrom('session')
          .select(['status'])
          .where('id', '=', pushedId)
          .executeTakeFirstOrThrow();
        expect(session.status).toBe('ended');
        expect(
          await db()
            .selectFrom('signal')
            .select('session_id')
            .where('session_id', '=', pushedId)
            .execute(),
        ).toHaveLength(1);
      });

      it('keeps event ids and grades across a re-push, and marks a grade stale when its evidence goes', async () => {
        await putSession(bob, pushedId, trace());
        const before = await eventsOf(pushedId);
        const rubricId = newId();
        await db()
          .insertInto('rubric')
          .values({
            id: rubricId,
            workspace_id: LOCAL_WORKSPACE_ID,
            name: 'r',
            version: '1',
            ordinal: 1,
            scale: 'binary',
            pass_threshold: 1,
            body_md: 'x',
            created_at: new Date().toISOString(),
          })
          .execute();
        const gradeId = newId();
        await db()
          .insertInto('grade')
          .values({
            id: gradeId,
            workspace_id: LOCAL_WORKSPACE_ID,
            session_id: pushedId,
            rubric_id: rubricId,
            rubric_version: '1',
            score: 1,
            passed: true,
            reason: 'ok',
            evidence_event_ids: JSON.stringify([before[1]?.id]),
            judge_model: 'fake',
            transport: 'fake',
            graded_at: new Date().toISOString(),
          })
          .execute();

        const grown = trace();
        grown.events.push({
          seq: 2,
          ts: '2026-10-01T10:02:00Z',
          kind: 'assistant',
          output: 'done',
          sourceKey: 'c:0',
        });
        expect((await putSession(bob, pushedId, grown)).status).toBe(200);
        const after = await eventsOf(pushedId);
        expect(after.map((e) => e.id).slice(0, 2)).toEqual(before.map((e) => e.id));
        const status = () =>
          db()
            .selectFrom('grade')
            .select('status')
            .where('id', '=', gradeId)
            .executeTakeFirstOrThrow();
        expect((await status()).status).toBe('ok');

        const shrunk = trace();
        shrunk.events = shrunk.events.slice(0, 1);
        expect((await putSession(bob, pushedId, shrunk)).status).toBe(200);
        expect((await status()).status).toBe('stale');
      });

      it('answers 422 to an id that does not match the agent and native id, and to redaction off', async () => {
        const wrong = await putSession(bob, sessionId('codex', 'pushed-1'), trace());
        expect(wrong.status).toBe(422);
        expect(await wrong.json()).toMatchObject({ problems: [expect.stringContaining(pushedId)] });
        expect((await putSession(bob, pushedId, trace({ redactionVersion: 'off' }))).status).toBe(
          422,
        );
        expect(await db().selectFrom('session').select('id').execute()).toEqual([]);
      });

      it('answers 400 to a body that breaks the schema', async () => {
        const bad = trace();
        bad.events = [...bad.events].reverse();
        const res = await putSession(bob, pushedId, bad);
        expect(res.status).toBe(400);
        expect((await putSession(bob, pushedId, '{"agent":')).status).toBe(400);
      });

      it('caps a session body at 32 MiB and 50,000 events, whatever the raw upload cap', async () => {
        const big = appWith({ maxBytes: HUGE, quotaBytes: HUGE });
        const padded = gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1, ' '));
        const gz = { 'content-encoding': 'gzip' };
        expect((await putSession(bob, pushedId, padded, gz, big)).status).toBe(413);

        const many = trace({
          events: Array.from({ length: 50_001 }, (_, seq) => ({ seq, kind: 'user' })),
        });
        const res = await putSession(bob, pushedId, gzipSync(JSON.stringify(many)), gz, big);
        expect(res.status).toBe(400);
        expect(await db().selectFrom('session').select('id').execute()).toEqual([]);
      });

      it('parses at most two session bodies at once and answers 503 with Retry-After to more', async () => {
        const held = [0, 1].map(() => {
          let close = (): void => undefined;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              close = () => {
                controller.close();
              };
            },
          });
          const response = app.request(`${BASE}/v1/intake/sessions/${pushedId}`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' },
            body,
            duplex: 'half',
          } as RequestInit);
          return { close, response };
        });
        // Until both held requests are being read, a probe is parsed (and refused as bad JSON).
        await vi.waitFor(async () => {
          const busy = await putSession(bob, pushedId, 'not json');
          expect(busy.status).toBe(503);
          expect(busy.headers.get('retry-after')).toMatch(/^\d+$/);
          expect(busy.headers.get('content-type')).toContain('application/problem+json');
        });
        for (const h of held) h.close();
        for (const h of held) expect((await h.response).status).toBe(400);
        expect((await putSession(bob, pushedId, trace())).status).toBe(200);
      });

      it('answers 409 when a log file on the server owns the session, or another person does', async () => {
        await putLog(alice, 'claude_code', CLAUDE_PATH, lines());
        await drain();
        const rawId = sessionId('claude_code', CLAUDE_SESSION_ID);
        const res = await putSession(alice, rawId, trace({ nativeId: CLAUDE_SESSION_ID }));
        expect(res.status).toBe(409);

        await putSession(bob, pushedId, trace());
        const other = await putSession(alice, pushedId, trace());
        expect(other.status).toBe(409);
        // One message for both, so a pusher cannot learn whose sessions exist.
        expect(await other.json()).toEqual(await res.json());
        expect(
          (
            await db()
              .selectFrom('session')
              .select('user_id')
              .where('id', '=', pushedId)
              .executeTakeFirstOrThrow()
          ).user_id,
        ).toBe(bob.userId);
      });

      it('answers 409 to a raw log of a session pushed redacted or owned by someone else, and stores nothing', async () => {
        const sid = sessionId('claude_code', CLAUDE_SESSION_ID);
        await putSession(alice, sid, trace({ nativeId: CLAUDE_SESSION_ID }));
        const redacted = await putLog(alice, 'claude_code', CLAUDE_PATH, lines());
        expect(redacted.status).toBe(409);
        expect(existsSync(join(intakeDir(alice), CLAUDE_PATH))).toBe(false);
        await drain();
        expect(await eventsOf(sid)).toHaveLength(2);

        const other = await putLog(bob, 'claude_code', CLAUDE_PATH, lines());
        expect(other.status).toBe(409);
        expect(await other.json()).toEqual(await redacted.json());
        expect(existsSync(join(intakeDir(bob), CLAUDE_PATH))).toBe(false);
      });
    });
  });
}
