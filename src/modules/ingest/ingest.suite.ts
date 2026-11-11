import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import { newId, sessionId } from '../../platform/db/ids.js';
import { fromJson } from '../../platform/db/json.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import { createJobQueue } from '../../platform/jobs/queue.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';
import { createSecretStore, createSettings } from '../settings/index.js';
import { createIngest, REDACTION_VERSION, type IngestService, type S3Api } from './index.js';
import { fakeS3Api } from '../../platform/testkit/s3.js';
import {
  CLAUDE_SESSION_ID,
  CLAUDE_TOKENS,
  claudeSessionLines,
  CODEX_SESSION_ID,
  PLANTED,
  SECRETS,
  writeFixtureSources,
} from '../../platform/testkit/agent-fixtures.js';

const DAY_MS = 86_400_000;
const TABLES = ['session', 'event', 'signal', 'ingest_cursor', 'source', 'setting', 'job'] as const;

export function ingestSuite(name: string, make: TestDbFactory): void {
  describe(`ingest (${name})`, () => {
    let t: TestDb;
    let dir: string;
    let ingest: IngestService;
    let sources: { claude: string; codex: string; claudeFile: string };
    let s3Api: S3Api = fakeS3Api({}).api;

    const build = (): IngestService => {
      const settings = createSettings(
        t.handle.db,
        LOCAL_WORKSPACE_ID,
        createSecretStore(join(dir, 'data')),
      );
      return createIngest({
        db: t.handle.db,
        workspaceId: LOCAL_WORKSPACE_ID,
        userId: LOCAL_USER_ID,
        dataDir: join(dir, 'data'),
        settings,
        queue: createJobQueue(t.handle),
        pollMode: false,
        s3Api: () => s3Api,
      });
    };
    const count = async (table: 'session' | 'event'): Promise<number> =>
      Number(
        (
          await t.handle.db
            .selectFrom(table)
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
    const sessionIdOf = async (agent: string): Promise<string> =>
      (
        await t.handle.db
          .selectFrom('session')
          .select('id')
          .where('agent', '=', agent)
          .executeTakeFirstOrThrow()
      ).id;
    const importAll = async (): Promise<void> => {
      await ingest.importAll();
    };

    beforeEach(async () => {
      t = await make();
      dir = mkdtempSync(join(tmpdir(), 'introspect-ingest-'));
      sources = writeFixtureSources(dir);
      ingest = build();
      await ingest.sources.add('claude_code', sources.claude);
      await ingest.sources.add('codex', sources.codex);
    });
    afterEach(async () => {
      await t.destroy();
      rmSync(dir, { recursive: true, force: true });
    });

    it('imports both agents, skips subagent transcripts and normalizes events', async () => {
      await importAll();
      expect(await count('session')).toBe(2);
      const id = await sessionIdOf('claude_code');
      const detail = await ingest.sessions.get(id);
      expect(detail).toMatchObject({
        agent: 'claude_code',
        repo: 'demo',
        branch: 'feature/x',
        model: 'claude-opus-5-5',
        tokensIn: CLAUDE_TOKENS.in,
        tokensOut: CLAUDE_TOKENS.out,
        tokensCacheRead: CLAUDE_TOKENS.cacheRead,
        tokensCacheWrite: CLAUDE_TOKENS.cacheWrite,
        outcome: {
          kind: 'pr_open',
          ref: 'https://github.com/example/demo/pull/7',
          url: 'https://github.com/example/demo/pull/7',
        },
      });
      const page = await ingest.sessions.events(id, { filter: 'all', limit: 500 });
      const kinds = page?.items.map((e) => e.kind) ?? [];
      expect(kinds).toEqual(
        expect.arrayContaining([
          'user',
          'assistant',
          'tool_call',
          'file_op',
          'mcp',
          'skill',
          'unknown',
        ]),
      );
      const failing = page?.items.find((e) => e.name === 'bash' && e.isError);
      expect(failing?.text).toContain('`pnpm test`');
      expect(failing?.output).toContain('FAIL');
      expect(failing?.offsetS).toBeGreaterThan(0);
      expect(page?.items.find((e) => e.kind === 'skill')?.text).toBe('Loaded e2e-testing');
      const codex = await ingest.sessions.get(await sessionIdOf('codex'));
      expect(codex).toMatchObject({
        model: 'gpt-5-codex',
        tokensIn: 300,
        tokensOut: 60,
        tokensCacheRead: 200,
        tokensCacheWrite: 0,
        repo: 'codex-demo',
      });
    });

    it('computes signals, flags the failing session and records adapter warnings', async () => {
      await importAll();
      const id = await sessionIdOf('claude_code');
      const signal = await t.handle.db
        .selectFrom('signal')
        .selectAll()
        .where('session_id', '=', id)
        .executeTakeFirstOrThrow();
      expect(signal).toMatchObject({
        failed_tool_calls: 3,
        repeated_commands: 1,
        tests_run: 3,
        files_touched: 2,
      });
      expect(signal.retries).toBeGreaterThanOrEqual(2);
      const session = await t.handle.db
        .selectFrom('session')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(Boolean(session.flagged)).toBe(true);
      expect(session.status).toBe('ended');
      expect(fromJson(session.ingest_warnings)).toMatchObject({ unknown: 1 });
      expect(session.redaction_version).toBe(REDACTION_VERSION);
    });

    it('stores no planted secret in any column of any table', async () => {
      await importAll();
      for (const table of TABLES) {
        const rows = JSON.stringify(await t.handle.db.selectFrom(table).selectAll().execute());
        for (const secret of PLANTED)
          expect(rows, `${table} leaks ${secret.slice(0, 12)}`).not.toContain(secret);
      }
      const id = await sessionIdOf('claude_code');
      const page = await ingest.sessions.events(id, { filter: 'all', limit: 500 });
      const all = JSON.stringify(page?.items);
      expect(all).toContain('[REDACTED:github-token:');
      expect(all).toContain('[REDACTED:sensitive-file:');
      expect(all).toContain('[REDACTED:private-key:');
      expect(all).toContain('[REDACTED:url-credentials:');
      const session = await ingest.sessions.get(id);
      expect(session?.title).toContain('[REDACTED:aws-access-key:');
    });

    it('is idempotent: a second import changes nothing', async () => {
      await importAll();
      const before = { sessions: await count('session'), events: await count('event') };
      await importAll();
      await importAll();
      expect({ sessions: await count('session'), events: await count('event') }).toEqual(before);
    });

    it('resumes from the byte cursor after an append, pairing a result with a call from the earlier chunk', async () => {
      const lines = claudeSessionLines();
      const live = join(dir, 'live', 'claude', 'projects', '-work-live');
      mkdirSync(live, { recursive: true });
      const file = join(live, '77777777-1111-4222-8333-444455556666.jsonl');
      const callIndex = lines.findIndex((l) => l.includes('"toolu_db"') && l.includes('tool_use'));
      writeFileSync(file, `${lines.slice(0, callIndex + 1).join('\n')}\n`);
      const source = await ingest.sources.add(
        'claude_code',
        join(dir, 'live', 'claude', 'projects'),
      );
      await importAll();
      const id = (
        await t.handle.db
          .selectFrom('session')
          .select('id')
          .where('native_id', '=', '77777777-1111-4222-8333-444455556666')
          .executeTakeFirstOrThrow()
      ).id;
      const open = await t.handle.db
        .selectFrom('event')
        .select(['output', 'seq'])
        .where('session_id', '=', id)
        .where('call_id', '=', 'toolu_db')
        .executeTakeFirstOrThrow();
      expect(open.output).toBeNull();
      const eventsBefore = await count('event');

      appendFileSync(file, `${lines.slice(callIndex + 1).join('\n')}\n`);
      await importAll();
      const paired = await t.handle.db
        .selectFrom('event')
        .select(['output', 'ms'])
        .where('session_id', '=', id)
        .where('call_id', '=', 'toolu_db')
        .executeTakeFirstOrThrow();
      expect(paired.output).toContain('[REDACTED:url-credentials:');
      expect(paired.ms).toBe(1000);
      expect(await count('event')).toBeGreaterThan(eventsBefore);
      const seqs = (
        await t.handle.db
          .selectFrom('event')
          .select('seq')
          .where('session_id', '=', id)
          .orderBy('seq')
          .execute()
      ).map((r) => r.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i));
      expect(source.status).toBe('watching');
    });

    it('does not consume a half-written last line', async () => {
      const file = join(
        dir,
        'live2',
        'claude',
        'projects',
        '-work-live',
        '88888888-1111-4222-8333-444455556666.jsonl',
      );
      mkdirSync(join(file, '..'), { recursive: true });
      const lines = claudeSessionLines();
      const [first, second] = [lines[2] ?? '', lines[5] ?? ''];
      writeFileSync(file, `${first}\n${second.slice(0, 40)}`);
      await ingest.sources.add('claude_code', join(dir, 'live2', 'claude', 'projects'));
      await importAll();
      const row = await t.handle.db
        .selectFrom('ingest_cursor')
        .select('byte_offset')
        .where('file_path', '=', file)
        .executeTakeFirstOrThrow();
      expect(row.byte_offset).toBe(Buffer.byteLength(first) + 1);
      appendFileSync(file, `${second.slice(40)}\n`);
      await importAll();
      const events = await t.handle.db
        .selectFrom('event')
        .innerJoin('session', 'session.id', 'event.session_id')
        .select('event.kind')
        .where('session.native_id', '=', '88888888-1111-4222-8333-444455556666')
        .execute();
      expect(events.map((e) => e.kind)).toEqual(['user', 'assistant']);
    });

    it('rebuilds a session when its file is truncated and replaced', async () => {
      await importAll();
      const id = await sessionIdOf('claude_code');
      const before = await count('event');
      writeFileSync(sources.claudeFile, `${claudeSessionLines().slice(2, 4).join('\n')}\n`);
      await importAll();
      const after = (
        await t.handle.db
          .selectFrom('event')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('session_id', '=', id)
          .executeTakeFirstOrThrow()
      ).n;
      expect(Number(after)).toBeLessThan(before);
      expect(Number(after)).toBeGreaterThan(0);
      truncateSync(sources.claudeFile, 0);
      await importAll();
      expect(await ingest.sessions.get(id)).not.toBeNull();
    });

    it('reconcile queues files that changed, and only files newer than the source for unknown ones', async () => {
      await importAll();
      expect(await ingest.reconcile()).toBe(0);
      appendFileSync(sources.claudeFile, `${claudeSessionLines()[2] ?? ''}\n`);
      expect(await ingest.reconcile()).toBe(1);
    });

    it('lists, filters and paginates sessions', async () => {
      await importAll();
      const all = await ingest.sessions.list({ limit: 1 });
      expect(all.items).toHaveLength(1);
      expect(all.nextCursor).not.toBeNull();
      const next = await ingest.sessions.list({ limit: 1, cursor: all.nextCursor ?? '' });
      expect(next.items[0]?.id).not.toBe(all.items[0]?.id);
      expect((await ingest.sessions.list({ limit: 10, agent: 'codex' })).items).toHaveLength(1);
      expect((await ingest.sessions.list({ limit: 10, q: 'AKIAIOSFODNN7' })).items).toHaveLength(0);
      expect((await ingest.sessions.list({ limit: 10, q: 'fix the failing' })).items).toHaveLength(
        1,
      );
      expect((await ingest.sessions.list({ limit: 10, q: '100%_' })).items).toHaveLength(0);
      expect((await ingest.sessions.list({ limit: 10, result: 'failed_any' })).items).toHaveLength(
        0,
      );
      const flagged = (await ingest.sessions.list({ limit: 10, agent: 'claude_code' })).items[0];
      expect(flagged?.toolErrors).toBe(3);
      const errors = await ingest.sessions.events(await sessionIdOf('claude_code'), {
        filter: 'errors',
        limit: 2,
      });
      expect(errors?.total).toBe(3);
      expect(errors?.items).toHaveLength(2);
      expect(errors?.nextCursor).not.toBeNull();
    });

    it('purges payloads past retention, keeping pinned sessions and everything else about the session', async () => {
      await importAll();
      const claude = await sessionIdOf('claude_code');
      const codex = await sessionIdOf('codex');
      expect(await ingest.pinSession(codex)).toBe(true);
      const rubricId = newId();
      await t.handle.db
        .insertInto('rubric')
        .values({
          id: rubricId,
          workspace_id: LOCAL_WORKSPACE_ID,
          name: 'r',
          version: rubricId,
          ordinal: 1,
          scale: '[0,1]',
          pass_threshold: 0.5,
          body_md: 'x',
          created_at: new Date().toISOString(),
        })
        .execute();
      for (const sessionId of [claude, codex])
        await t.handle.db
          .insertInto('grade')
          .values({
            id: newId(),
            workspace_id: LOCAL_WORKSPACE_ID,
            session_id: sessionId,
            rubric_id: rubricId,
            rubric_version: rubricId,
            score: 0,
            passed: false,
            reason: 'quotes the prompt: hunter2',
            judge_model: 'fake-judge',
            transport: 'fake',
            graded_at: new Date().toISOString(),
          })
          .execute();
      const purged = await ingest.purgePayloads(30);
      const reasons = await t.handle.db
        .selectFrom('grade')
        .select(['session_id', 'reason'])
        .execute();
      expect(reasons.find((g) => g.session_id === claude)?.reason).toBe('(reason purged)');
      expect(reasons.find((g) => g.session_id === codex)?.reason).toContain('hunter2');
      expect(purged).toBeGreaterThan(0);
      const page = await ingest.sessions.events(claude, { filter: 'all', limit: 500 });
      expect(
        page?.items.every((e) => e.payloadPurged && e.input === null && e.output === null),
      ).toBe(true);
      expect(page?.total).toBeGreaterThan(0);
      const pinned = await ingest.sessions.events(codex, { filter: 'all', limit: 500 });
      expect(pinned?.items.some((e) => e.payloadPurged)).toBe(false);
      expect((await ingest.sessions.get(claude))?.title).toBe('(title purged)');
      expect((await ingest.sessions.get(codex))?.title).not.toBe('(title purged)');
    });

    it('keeps recent sessions when the window is long enough', async () => {
      await importAll();
      const oldDate = new Date('2020-01-01');
      utimesSync(sources.claudeFile, oldDate, oldDate);
      expect(await ingest.purgePayloads(100_000)).toBe(0);
    });

    it('lists sessions from a start time on, together with the other filters and cursor paging', async () => {
      await importAll();
      const all = await ingest.sessions.list({ limit: 50 });
      expect(all.items).toHaveLength(2);
      const [newest, oldest] = all.items;
      expect(
        (await ingest.sessions.list({ since: '2026-09-01T00:00:00.000Z', limit: 50 })).items,
      ).toHaveLength(2);
      expect(
        (await ingest.sessions.list({ since: '2026-11-01T00:00:00.000Z', limit: 50 })).items,
      ).toEqual([]);
      // The boundary is inclusive: a session that started exactly at `since` is listed.
      const at = await ingest.sessions.list({ since: newest?.startedAt ?? '', limit: 50 });
      expect(at.items.map((s) => s.id)).toContain(newest?.id);
      // Paging keeps the filter.
      const first = await ingest.sessions.list({ since: oldest?.startedAt ?? '', limit: 1 });
      expect(first.items).toHaveLength(1);
      const second = await ingest.sessions.list({
        since: oldest?.startedAt ?? '',
        limit: 1,
        ...(first.nextCursor && { cursor: first.nextCursor }),
      });
      expect(second.items.every((s) => s.startedAt >= (oldest?.startedAt ?? ''))).toBe(true);
      expect(
        (
          await ingest.sessions.list({ since: newest?.startedAt ?? '', agent: 'codex', limit: 50 })
        ).items.every((s) => s.agent === 'codex'),
      ).toBe(true);
    });

    it('counts sessions in a time window and exposes the raw file path', async () => {
      await importAll();
      const id = await sessionIdOf('claude_code');
      expect(await ingest.sessions.countStartedSince(new Date('2026-09-01'))).toBe(2);
      expect(await ingest.sessions.countStartedSince(new Date('2026-11-01'))).toBe(0);
      expect(await ingest.sessions.rawPath(id)).toBe(sources.claudeFile);
    });

    it('queues an ingest job when a watched file changes', async () => {
      ingest.startWatching((e) => {
        throw e;
      });
      const watched = join(dir, 'watched');
      mkdirSync(watched);
      await ingest.sources.add('claude_code', watched);
      await new Promise((resolve) => setTimeout(resolve, 500)); // let the watcher settle
      mkdirSync(join(watched, '-p'));
      writeFileSync(
        join(watched, '-p', '99999999-1111-4222-8333-444455556666.jsonl'),
        `${claudeSessionLines()[2] ?? ''}\n`,
      );
      const queued = async (): Promise<number> =>
        Number(
          (
            await t.handle.db
              .selectFrom('job')
              .select((eb) => eb.fn.countAll().as('n'))
              .where('kind', '=', 'ingest_file')
              .executeTakeFirstOrThrow()
          ).n,
        );
      for (let i = 0; i < 60 && (await queued()) === 0; i += 1)
        await new Promise((r) => setTimeout(r, 250));
      await ingest.stopWatching();
      expect(await queued()).toBe(1);
    }, 20_000);

    describe('incremental token accounting', () => {
      const SID = '55555555-1111-4222-8333-444455556666';
      const assistant = (id: string, usage: Record<string, number>, text = 'x') =>
        JSON.stringify({
          type: 'assistant',
          cwd: '/work/live',
          sessionId: SID,
          timestamp: '2026-10-01T10:00:00.000Z',
          message: { model: 'm', id, role: 'assistant', content: [{ type: 'text', text }], usage },
        });
      const usage = (i: number, o: number, cr: number, cw: number) => ({
        input_tokens: i,
        output_tokens: o,
        cache_read_input_tokens: cr,
        cache_creation_input_tokens: cw,
      });

      it('counts a message once when its lines straddle two ingest runs, and splits cache from input', async () => {
        const dirp = join(dir, 'tok', 'projects', '-work-live');
        mkdirSync(dirp, { recursive: true });
        const file = join(dirp, `${SID}.jsonl`);
        writeFileSync(file, `${assistant('msg_x', usage(10, 5, 100, 5))}\n`);
        await ingest.sources.add('claude_code', join(dir, 'tok', 'projects'));
        await importAll();
        appendFileSync(
          file,
          `${assistant('msg_x', usage(10, 30, 100, 5))}\n${assistant('msg_y', usage(2, 8, 50, 0))}\n`,
        );
        await importAll();
        await importAll();
        const row = await t.handle.db
          .selectFrom('session')
          .select(['id'])
          .where('native_id', '=', SID)
          .executeTakeFirstOrThrow();
        expect(await ingest.sessions.get(row.id)).toMatchObject({
          tokensIn: 12,
          tokensOut: 38,
          tokensCacheRead: 150,
          tokensCacheWrite: 5,
        });
      });
    });

    describe('redaction of sensitive files and metadata', () => {
      const SID = '66666666-1111-4222-8333-444455556666';
      const VALUE = 'zz-harmless-looking-value-42';
      const rec = (type: string, content: unknown[], extra: Record<string, unknown> = {}) =>
        JSON.stringify({
          type,
          cwd: `/work/${SECRETS.github}/app`,
          gitBranch: `feat/${SECRETS.aws}`,
          sessionId: SID,
          timestamp: '2026-10-01T10:00:00.000Z',
          message: { role: type, id: `m${String(Math.random())}`, content },
          ...extra,
        });
      const call = (id: string, name: string, input: unknown) =>
        rec('assistant', [{ type: 'tool_use', id, name, input }]);
      const result = (id: string, text: string) =>
        rec('user', [{ type: 'tool_result', tool_use_id: id, content: text }]);

      it('redacts writes to credential files, bash output that reads them and session metadata', async () => {
        const root = join(dir, 'sens', 'projects');
        mkdirSync(join(root, '-work-app'), { recursive: true });
        writeFileSync(
          join(root, '-work-app', `${SID}.jsonl`),
          `${[
            call('t1', 'Write', { file_path: '/w/.env', content: `A=${VALUE}` }),
            call('t2', 'Edit', {
              file_path: '/h/.npmrc',
              old_string: VALUE,
              new_string: `x=${VALUE}`,
            }),
            call('t3', 'MultiEdit', {
              file_path: '/h/.aws/credentials',
              edits: [{ old_string: 'a', new_string: VALUE }],
            }),
            call('t4', 'Write', { file_path: '/w/src/a.ts', content: 'export const a = 1;' }),
            call('t5', 'Bash', { command: 'cat /home/u/.claude/.credentials.json' }),
            result('t5', `{"accessToken":"${VALUE}"}`),
            call('t6', 'Bash', { command: 'ls -la' }),
            result('t6', `total 1 ${VALUE}`),
            call(`t7`, 'mcp__x__tool', {}),
          ].join('\n')}\n`,
        );
        await ingest.sources.add('claude_code', root);
        await importAll();
        const id = (
          await t.handle.db
            .selectFrom('session')
            .select('id')
            .where('native_id', '=', SID)
            .executeTakeFirstOrThrow()
        ).id;
        const events =
          (await ingest.sessions.events(id, { filter: 'all', limit: 100 }))?.items ?? [];
        const byCall = (n: number) => events.filter((e) => e.kind !== 'assistant')[n];
        for (const n of [0, 1, 2]) {
          expect(byCall(n)?.input, `write ${String(n)}`).not.toContain(VALUE);
          expect(byCall(n)?.input).toContain('[REDACTED:sensitive-file:');
        }
        expect(byCall(0)?.input).toContain('/w/.env');
        expect(byCall(3)?.input).toContain('export const a = 1;');
        expect(byCall(4)?.output).toMatch(/^\[REDACTED:sensitive-file:/);
        expect(byCall(5)?.output).toContain(VALUE);
        const row = await t.handle.db
          .selectFrom('session')
          .select(['cwd', 'branch', 'repo'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        expect(JSON.stringify(row)).not.toContain(SECRETS.github);
        expect(JSON.stringify(row)).not.toContain(SECRETS.aws);
        expect(row.cwd).toContain('[REDACTED:github-token:');
      });

      it('redacts event and skill names', async () => {
        const root = join(dir, 'names', 'projects');
        mkdirSync(join(root, '-work-app'), { recursive: true });
        writeFileSync(
          join(root, '-work-app', `${SID}.jsonl`),
          `${[
            call('s1', 'Skill', { skill: `deploy-${SECRETS.github}` }),
            call('s2', `mcp__srv-${SECRETS.github}-run`, {}),
          ].join('\n')}\n`,
        );
        await ingest.sources.add('claude_code', root);
        await importAll();
        const names = await t.handle.db.selectFrom('event').select('name').execute();
        expect(JSON.stringify(names)).not.toContain(SECRETS.github);
        expect(JSON.stringify(names)).toContain('[REDACTED:github-token:');
      });
    });

    describe('sources', () => {
      it('stores the real path without trailing slash and treats spellings as one source', async () => {
        const real = join(dir, 'spell', 'projects');
        mkdirSync(real, { recursive: true });
        symlinkSync(real, join(dir, 'link'));
        const a = await ingest.sources.add('claude_code', `${real}/`);
        const b = await ingest.sources.add('claude_code', join(dir, 'link'));
        expect(a.path).toBe(realpathSync(real));
        expect(b.id).toBe(a.id);
      });

      it('rejects a source nested in, or around, another source of the same agent with a conflict', async () => {
        await expect(
          ingest.sources.add('claude_code', join(sources.claude, '-work-demo')),
        ).rejects.toBeInstanceOf(ConflictError);
        await expect(ingest.sources.add('claude_code', dir)).rejects.toBeInstanceOf(ConflictError);
      });

      it('ingests a session file once when a copy of it sits under a second source', async () => {
        await importAll();
        const before = { sessions: await count('session'), events: await count('event') };
        const second = join(dir, 'copy', 'projects');
        mkdirSync(join(second, '-work-demo'), { recursive: true });
        copyFileSync(sources.claudeFile, join(second, '-work-demo', `${CLAUDE_SESSION_ID}.jsonl`));
        await ingest.sources.add('claude_code', second);
        await importAll();
        await importAll();
        expect({ sessions: await count('session'), events: await count('event') }).toEqual(before);
      });

      it('matches watcher events of a source stored with a trailing slash', async () => {
        const watched = join(dir, 'slash');
        mkdirSync(join(watched, '-p'), { recursive: true });
        const file = join(watched, '-p', '99999999-2222-4222-8333-444455556666.jsonl');
        writeFileSync(file, `${claudeSessionLines()[2] ?? ''}\n`);
        const added = await ingest.sources.add('claude_code', watched);
        await t.handle.db
          .updateTable('source')
          .set({ path: `${added.path}/` })
          .where('id', '=', added.id)
          .execute();
        expect(await ingest.handleFileEvent(file)).toBe(true);
      });
    });

    describe('disabling and removing sources', () => {
      const claudeSource = async () =>
        (await ingest.sources.list()).find((s) => s.path === realpathSync(sources.claude));
      const sessionRows = () =>
        t.handle.db.selectFrom('session').select(['id', 'origin']).orderBy('id').execute();

      it('counts the sessions of each source', async () => {
        await importAll();
        const list = await ingest.sources.list();
        expect(list.map((s) => s.sessionCount).sort()).toEqual([1, 1]);
        const extra = join(dir, 'empty');
        mkdirSync(extra);
        expect((await ingest.sources.add('codex', extra)).sessionCount).toBe(0);
      });

      it('keeps the sessions of a removed folder source, and re-adding it appends to them without duplicates', async () => {
        await importAll();
        const before = { sessions: await sessionRows(), events: await count('event') };
        const src = await claudeSource();
        await ingest.sources.remove(src?.id ?? '');
        expect(await claudeSource()).toBeUndefined();
        expect(existsSync(sources.claudeFile)).toBe(true);
        expect(await sessionRows()).toEqual(before.sessions);
        expect(await count('event')).toBe(before.events);

        appendFileSync(sources.claudeFile, `${claudeSessionLines()[2] ?? ''}\n`);
        await ingest.sources.add('claude_code', sources.claude);
        await importAll();
        expect(await sessionRows()).toEqual(before.sessions);
        expect(await count('event')).toBe(before.events + 1);
        await importAll();
        expect(await count('event')).toBe(before.events + 1);
      });

      it('skips the files of a disabled source and ingests what changed meanwhile once it is enabled', async () => {
        await importAll();
        const src = await claudeSource();
        const off = await ingest.sources.setEnabled(src?.id ?? '', false);
        expect(off).toMatchObject({ enabled: false, status: 'disabled' });
        const events = await count('event');
        appendFileSync(sources.claudeFile, `${claudeSessionLines()[2] ?? ''}\n`);
        expect(await ingest.reconcile()).toBe(0);
        await importAll();
        expect(await count('event')).toBe(events);

        expect((await ingest.sources.setEnabled(src?.id ?? '', true)).enabled).toBe(true);
        expect(await ingest.reconcile()).toBe(1);
      });

      it('finalizes an active session once its source is removed and it went quiet', async () => {
        await importAll();
        const sid = await sessionIdOf('claude_code');
        const status = async () =>
          (
            await t.handle.db
              .selectFrom('session')
              .select('status')
              .where('id', '=', sid)
              .executeTakeFirstOrThrow()
          ).status;
        // A session still running when its source is removed.
        await t.handle.db
          .updateTable('session')
          .set({ status: 'active' })
          .where('id', '=', sid)
          .execute();
        await ingest.sources.remove((await claudeSource())?.id ?? '');
        // No cursor is left; the fixture events are far older than the idle window.
        await ingest.reconcile();
        expect(await status()).not.toBe('active');
      });

      it('keeps a disabled owner of a session: a shorter copy elsewhere never rebuilds it', async () => {
        await importAll();
        const events = await count('event');
        // A second folder holds an older, shorter copy of the same Claude session.
        const copyRoot = join(dir, 'copy');
        const copy = join(copyRoot, relative(sources.claude, sources.claudeFile));
        mkdirSync(dirname(copy), { recursive: true });
        writeFileSync(copy, `${claudeSessionLines().slice(0, 1).join('\n')}\n`);
        await ingest.sources.add('claude_code', copyRoot);
        const owner = await claudeSource();
        await ingest.sources.setEnabled(owner?.id ?? '', false);
        await importAll();
        expect(await count('event')).toBe(events);

        // Enabled again, the owner continues where it was: one new line, one new event.
        await ingest.sources.setEnabled(owner?.id ?? '', true);
        appendFileSync(sources.claudeFile, `${claudeSessionLines()[2] ?? ''}\n`);
        await importAll();
        expect(await count('event')).toBe(events + 1);
      });

      it('refuses to disable a pushed source and reports unknown ids', async () => {
        const folder = join(dir, 'pushed');
        mkdirSync(folder);
        const pushed = await ingest.sources.add('claude_code', folder, { kind: 'intake' });
        await expect(ingest.sources.setEnabled(pushed.id, false)).rejects.toThrow(
          /revoke the person's token/,
        );
        await expect(ingest.sources.setEnabled(pushed.id, false)).rejects.toBeInstanceOf(
          InvalidInputError,
        );
        await expect(ingest.sources.setEnabled(newId(), false)).rejects.toBeInstanceOf(
          NotFoundError,
        );
        await expect(ingest.sources.remove(newId())).rejects.toBeInstanceOf(NotFoundError);
      });

      it('deletes the cache folder of a removed S3 source and keeps its sessions', async () => {
        s3Api = fakeS3Api({
          'logs/-work-s3/s3-session.jsonl': {
            body: claudeSessionLines().join('\n') + '\n',
            lastModified: new Date(),
          },
        }).api;
        const s3 = await ingest.sources.addS3('claude_code', { bucket: 'b', prefix: 'logs' });
        await ingest.syncS3();
        await importAll();
        const sessions = await count('session');
        expect(existsSync(s3.path)).toBe(true);
        await ingest.sources.remove(s3.id);
        expect(existsSync(s3.path)).toBe(false);
        expect(await count('session')).toBe(sessions);
      });

      it('deletes the folder of a removed intake source', async () => {
        const person = newId();
        await t.handle.db
          .insertInto('app_user')
          .values({
            id: person,
            workspace_id: LOCAL_WORKSPACE_ID,
            display_name: 'Ada',
            share_sessions: true,
            created_at: new Date().toISOString(),
          })
          .execute();
        const folder = join(dir, 'data', 'intake', person, 'claude_code');
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'x.jsonl'), '{}\n');
        const added = await ingest.sources.add('claude_code', folder, {
          kind: 'intake',
          userId: person,
        });
        await ingest.sources.remove(added.id);
        expect(existsSync(folder)).toBe(false);
        expect((await ingest.sources.list()).some((s) => s.id === added.id)).toBe(false);
      });

      it('refuses to delete a cache folder outside the data folder', async () => {
        s3Api = fakeS3Api({}).api;
        const s3 = await ingest.sources.addS3('claude_code', { bucket: 'b', prefix: 'logs' });
        const outside = join(dir, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'keep.txt'), 'x');
        await t.handle.db
          .updateTable('source')
          .set({ path: outside })
          .where('id', '=', s3.id)
          .execute();
        await expect(ingest.sources.remove(s3.id)).rejects.toBeInstanceOf(InvalidInputError);
        expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
        expect((await ingest.sources.list()).some((s) => s.id === s3.id)).toBe(true);
      });

      it('refuses to delete the copy root itself', async () => {
        s3Api = fakeS3Api({}).api;
        const s3 = await ingest.sources.addS3('claude_code', { bucket: 'b', prefix: 'logs' });
        const root = join(dir, 'data', 's3');
        await t.handle.db
          .updateTable('source')
          .set({ path: root })
          .where('id', '=', s3.id)
          .execute();
        await expect(ingest.sources.remove(s3.id)).rejects.toBeInstanceOf(InvalidInputError);
        expect(existsSync(root)).toBe(true);
      });

      it('skips an ingest job of a removed source, also when the remove races the job', async () => {
        const src = await claudeSource();
        const job = {
          payload: { sourceId: src?.id, path: sources.claudeFile },
        } as never;
        await ingest.sources.remove(src?.id ?? '');
        await expect(ingest.handlers.ingest_file?.run(job)).resolves.toBeUndefined();
        expect(await count('session')).toBe(0);

        const again = await ingest.sources.add('claude_code', sources.claude);
        const raced = { payload: { sourceId: again.id, path: sources.claudeFile } } as never;
        const results = await Promise.allSettled([
          ingest.handlers.ingest_file?.run(raced),
          ingest.sources.remove(again.id),
        ]);
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      });
    });

    describe('job housekeeping', () => {
      const jobsWith = async (status: string): Promise<number> =>
        Number(
          (
            await t.handle.db
              .selectFrom('job')
              .select((eb) => eb.fn.countAll().as('n'))
              .where('kind', '=', 'ingest_file')
              .where('status', '=', status as 'dead')
              .executeTakeFirstOrThrow()
          ).n,
        );

      it('re-enqueues an unchanged file whose ingest job died more than an hour ago', async () => {
        const root = join(dir, 'dead');
        mkdirSync(join(root, '-p'), { recursive: true });
        const file = join(root, '-p', '99999999-3333-4222-8333-444455556666.jsonl');
        writeFileSync(file, `${claudeSessionLines()[2] ?? ''}\n`);
        const soon = new Date(Date.now() + 60_000); // newer than the source, so reconcile finds it
        utimesSync(file, soon, soon);
        await ingest.sources.add('claude_code', root);
        expect(await ingest.reconcile()).toBe(1);
        const kill = (finishedAt: string) =>
          t.handle.db
            .updateTable('job')
            .set({ status: 'dead', finished_at: finishedAt })
            .where('kind', '=', 'ingest_file')
            .execute();
        await kill(new Date().toISOString());
        await ingest.reconcile();
        expect(await jobsWith('dead')).toBe(1); // died just now: leave it for the retry action
        await kill(new Date(Date.now() - 2 * 3600_000).toISOString());
        await ingest.reconcile();
        expect(await jobsWith('dead')).toBe(0);
        expect(await jobsWith('queued')).toBe(1);
      });

      it('prunes finished jobs older than seven days with the daily purge', async () => {
        const insert = (id: string, status: 'succeeded' | 'dead' | 'queued', daysAgo: number) =>
          t.handle.db
            .insertInto('job')
            .values({
              id,
              workspace_id: LOCAL_WORKSPACE_ID,
              kind: 'x',
              payload: '{}',
              status,
              run_after: new Date().toISOString(),
              created_at: new Date().toISOString(),
              finished_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
            })
            .execute();
        await insert('018f0000-0000-7000-8000-00000000000a', 'succeeded', 8);
        await insert('018f0000-0000-7000-8000-00000000000b', 'dead', 8);
        await insert('018f0000-0000-7000-8000-00000000000c', 'succeeded', 1);
        await ingest.handlers.purge_payloads?.run({} as never);
        const left = await t.handle.db
          .selectFrom('job')
          .select('id')
          .where('kind', '=', 'x')
          .execute();
        expect(left.map((r) => r.id)).toEqual(['018f0000-0000-7000-8000-00000000000c']);
      });
    });

    it('re-ingests a session whose adapter version is outdated, keeping pins and event ids', async () => {
      await importAll();
      const id = await sessionIdOf('claude_code');
      const before = await ingest.sessions.events(id, { filter: 'all', limit: 500 });
      // A row stored by an older release: wrong version and legacy token counts (cache included in `in`).
      await t.handle.db
        .updateTable('session')
        .set({ adapter_version: '0', tokens_in: 99_999, pinned: true })
        .where('id', '=', id)
        .execute();
      expect(await ingest.reconcile()).toBeGreaterThanOrEqual(1);
      const job = await t.handle.db
        .selectFrom('job')
        .selectAll()
        .where('kind', '=', 'ingest_file')
        .where('status', '=', 'queued')
        .execute();
      const forced = job.filter((j) => (fromJson(j.payload) as { force?: boolean }).force);
      expect(forced).toHaveLength(1);
      await ingest.handlers.ingest_file?.run({ payload: fromJson(forced[0]?.payload) } as never);

      const detail = await ingest.sessions.get(id);
      expect(detail?.tokensIn).toBe(CLAUDE_TOKENS.in);
      const row = await t.handle.db
        .selectFrom('session')
        .select(['adapter_version', 'pinned'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.adapter_version).not.toBe('0');
      expect(Boolean(row.pinned)).toBe(true);
      const after = await ingest.sessions.events(id, { filter: 'all', limit: 500 });
      expect(after?.items.map((e) => e.id)).toEqual(before?.items.map((e) => e.id));
      // Current rows are left alone: no further forced job is queued.
      await ingest.reconcile();
      const again = await t.handle.db
        .selectFrom('job')
        .select('payload')
        .where('kind', '=', 'ingest_file')
        .execute();
      expect(again.filter((j) => (fromJson(j.payload) as { force?: boolean }).force)).toHaveLength(
        1,
      );
    });

    describe('forced re-ingest', () => {
      /** Forces a rebuild of the Claude session as the reconcile job does after a version bump. */
      const forceRebuild = async (id: string): Promise<void> => {
        await t.handle.db
          .updateTable('session')
          .set({ adapter_version: '0' })
          .where('id', '=', id)
          .execute();
        await ingest.reconcile();
        const job = await t.handle.db
          .selectFrom('job')
          .selectAll()
          .where('kind', '=', 'ingest_file')
          .where('status', '=', 'queued')
          .execute();
        const forced = job.filter((j) => (fromJson(j.payload) as { force?: boolean }).force);
        expect(forced).toHaveLength(1);
        await ingest.handlers.ingest_file?.run({ payload: fromJson(forced[0]?.payload) } as never);
      };
      const eventsOf = (id: string) =>
        t.handle.db
          .selectFrom('event')
          .select(['id', 'seq', 'call_id', 'source_key', 'input', 'output', 'payload_purged_at'])
          .where('session_id', '=', id)
          .orderBy('seq')
          .execute();
      const addGrade = async (sessionId: string, evidence: string[]): Promise<string> => {
        const rubricId = newId();
        await t.handle.db
          .insertInto('rubric')
          .values({
            id: rubricId,
            workspace_id: LOCAL_WORKSPACE_ID,
            name: `r-${rubricId}`,
            version: rubricId,
            ordinal: 1,
            scale: '[0,1]',
            pass_threshold: 0.5,
            body_md: 'x',
            created_at: new Date().toISOString(),
          })
          .execute();
        const id = newId();
        await t.handle.db
          .insertInto('grade')
          .values({
            id,
            workspace_id: LOCAL_WORKSPACE_ID,
            session_id: sessionId,
            rubric_id: rubricId,
            rubric_version: rubricId,
            score: 0,
            passed: false,
            reason: 'x',
            evidence_event_ids: JSON.stringify(evidence),
            judge_model: 'fake-judge',
            transport: 'fake',
            graded_at: new Date().toISOString(),
          })
          .execute();
        return id;
      };
      const statusOf = async (gradeId: string): Promise<string> =>
        (
          await t.handle.db
            .selectFrom('grade')
            .select('status')
            .where('id', '=', gradeId)
            .executeTakeFirstOrThrow()
        ).status;

      it('keeps the id of every event that is still in the log, even when events before it vanish', async () => {
        await importAll();
        const id = await sessionIdOf('claude_code');
        const before = await eventsOf(id);
        expect(before.every((e) => e.source_key !== null)).toBe(true);
        const mcp = before.find((e) => e.call_id === 'toolu_mcp');
        const edit = before.find((e) => e.call_id === 'toolu_edit');
        const last = before.at(-1);
        if (!mcp || !edit || !last) throw new Error('fixture changed');
        const keeps = await addGrade(id, [edit.id, last.id]);
        const loses = await addGrade(id, [mcp.id, edit.id]);

        // The log loses the record of the MCP call (a newer adapter that no longer emits it, say):
        // every later event moves up one position.
        const lines = readFileSync(sources.claudeFile, 'utf8').split('\n');
        const gone = lines.findIndex((l) => l.includes('"toolu_mcp"') && l.includes('tool_use"'));
        expect(gone).toBeGreaterThan(0);
        lines.splice(gone, 1);
        writeFileSync(sources.claudeFile, lines.join('\n'));
        await forceRebuild(id);

        const after = await eventsOf(id);
        expect(after).toHaveLength(before.length - 1);
        expect(after.find((e) => e.call_id === 'toolu_edit')?.id).toBe(edit.id); // not shifted by position
        expect(after.at(-1)?.id).toBe(last.id);
        expect(after.some((e) => e.id === mcp.id)).toBe(false);
        expect(await statusOf(keeps)).toBe('ok');
        expect(await statusOf(loses)).toBe('stale'); // its evidence no longer resolves
      });

      it('matches rows stored before the source key existed by position, kind and time', async () => {
        await importAll();
        const id = await sessionIdOf('claude_code');
        const before = await eventsOf(id);
        await t.handle.db.updateTable('event').set({ source_key: null }).execute();
        const grade = await addGrade(id, [before[3]?.id ?? '', before.at(-1)?.id ?? '']);
        await forceRebuild(id);
        expect((await eventsOf(id)).map((e) => e.id)).toEqual(before.map((e) => e.id));
        expect(await statusOf(grade)).toBe('ok');
      });

      it('never brings back a payload that retention already purged', async () => {
        await importAll();
        const id = await sessionIdOf('claude_code');
        await t.handle.db.updateTable('session').set({ status: 'ended' }).execute();
        expect(await ingest.purgePayloads(0)).toBeGreaterThan(0);
        const purged = await eventsOf(id);
        expect(purged.every((e) => e.input === null && e.output === null)).toBe(true);
        await forceRebuild(id);
        const after = await eventsOf(id);
        expect(after.map((e) => e.id)).toEqual(purged.map((e) => e.id));
        expect(after.every((e) => e.input === null && e.output === null)).toBe(true);
        expect(after.every((e) => e.payload_purged_at !== null)).toBe(true);
      });
    });

    it('stores a session under the user of the source that found it', async () => {
      const { db } = t.handle;
      const other = newId();
      await db
        .insertInto('app_user')
        .values({
          id: other,
          workspace_id: LOCAL_WORKSPACE_ID,
          display_name: 'Other',
          share_sessions: true,
          created_at: new Date().toISOString(),
        })
        .execute();
      await db.updateTable('source').set({ user_id: other }).where('agent', '=', 'codex').execute();
      await importAll();
      const users = await db.selectFrom('session').select(['agent', 'user_id']).execute();
      expect(users.find((u) => u.agent === 'codex')?.user_id).toBe(other);
      expect(users.find((u) => u.agent === 'claude_code')?.user_id).toBe(LOCAL_USER_ID);

      const ada = { id: other, name: 'Other' };
      const you = { id: LOCAL_USER_ID, name: 'You' };
      const { items } = await ingest.sessions.list({ limit: 10 });
      expect(items.find((s) => s.agent === 'codex')?.person).toEqual(ada);
      expect(items.find((s) => s.agent === 'claude_code')?.person).toEqual(you);
      const theirs = await ingest.sessions.list({ limit: 10, person: other });
      expect(theirs.items.map((s) => s.agent)).toEqual(['codex']);
      expect((await ingest.sessions.get(theirs.items[0]?.id ?? ''))?.person).toEqual(ada);
      expect(await ingest.sessions.people()).toEqual([
        { ...ada, sessions: 1 },
        { ...you, sessions: 1 },
      ]); // equal counts: by name
      expect(await ingest.sessions.list({ limit: 10, person: newId() })).toEqual({
        items: [],
        nextCursor: null,
      });
    });

    it('names who pushes to an intake source, and no one for the other kinds', async () => {
      const { db } = t.handle;
      const other = newId();
      await db
        .insertInto('app_user')
        .values({
          id: other,
          workspace_id: LOCAL_WORKSPACE_ID,
          display_name: 'Ada',
          share_sessions: true,
          created_at: new Date().toISOString(),
        })
        .execute();
      const folder = join(dir, 'intake-ada');
      mkdirSync(folder);
      const added = await ingest.sources.add('claude_code', folder, {
        kind: 'intake',
        userId: other,
      });
      expect(added.person).toEqual({ id: other, name: 'Ada' });
      const listed = await ingest.sources.list();
      expect(listed.find((s) => s.id === added.id)?.person).toEqual({ id: other, name: 'Ada' });
      expect(listed.filter((s) => s.kind === 'folder').every((s) => s.person === null)).toBe(true);
    });

    it('leaves a pushed session alone and finalizes it once idle', async () => {
      await importAll();
      const { db } = t.handle;
      const id = await sessionIdOf('claude_code');
      const before = await ingest.sessions.get(id);
      await db.deleteFrom('ingest_cursor').where('session_id', '=', id).execute();
      await db
        .updateTable('session')
        .set({ status: 'active', ended_at: '2020-01-01T00:00:00.000Z', origin: 'pushed' })
        .where('id', '=', id)
        .execute();
      const eventsBefore = await count('event');
      await importAll();
      expect(await count('event')).toBe(eventsBefore);
      expect(
        await db
          .selectFrom('ingest_cursor')
          .select('session_id')
          .where('session_id', '=', id)
          .execute(),
      ).toEqual([]);
      const row = await db
        .selectFrom('session')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.status).not.toBe('active');
      expect(before).not.toBeNull();
    });

    it('adds an S3 source, caches it under the data folder, syncs and ingests it', async () => {
      const lines = `${claudeSessionLines().join('\n')}\n`;
      s3Api = fakeS3Api({
        'logs/-work-s3/s3-session.jsonl': {
          body: lines,
          lastModified: new Date(Date.now() - DAY_MS),
        },
      }).api;
      const remote = { bucket: 'logs-bucket', prefix: 'logs' };
      const added = await ingest.sources.addS3('claude_code', remote);
      // The first sync is queued right away, not left to the next scheduled one.
      const syncs = await t.handle.db
        .selectFrom('job')
        .select('id')
        .where('kind', '=', 's3_sync')
        .execute();
      expect(syncs).toHaveLength(1);
      expect(added).toMatchObject({
        kind: 's3',
        remote: { bucket: 'logs-bucket', prefix: 'logs/' },
      });
      expect(added.path.startsWith(realpathSync(join(dir, 'data', 's3')))).toBe(true);
      expect((await ingest.sources.addS3('claude_code', remote)).id).toBe(added.id);

      expect(await ingest.syncS3()).toBe(1);
      expect(readFileSync(join(added.path, '-work-s3', 's3-session.jsonl'), 'utf8')).toBe(lines);
      expect(await ingest.syncS3()).toBe(0);
      const queued = await t.handle.db
        .selectFrom('job')
        .select('id')
        .where('kind', '=', 'ingest_file')
        .execute();
      expect(queued.length).toBeGreaterThan(0);
    });

    it('runs one S3 sync at a time, so syncs started together fetch an object once', async () => {
      const fake = fakeS3Api({
        'logs/-p/s.jsonl': {
          body: `${claudeSessionLines().join('\n')}\n`,
          lastModified: new Date(Date.now() - DAY_MS),
        },
      });
      s3Api = {
        ...fake.api,
        get: async (key: string) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return fake.api.get(key);
        },
      };
      await ingest.sources.addS3('claude_code', { bucket: 'b', prefix: 'logs' });
      const [a, b] = await Promise.all([ingest.syncS3(), ingest.syncS3()]);
      expect(a + b).toBe(1);
      expect(fake.gets).toHaveLength(1);
    });

    it('history import fetches S3 sources first', async () => {
      s3Api = fakeS3Api({
        'logs/-work-s3/s3-session.jsonl': {
          body: `${claudeSessionLines().join('\n')}\n`,
          lastModified: new Date(Date.now() - DAY_MS),
        },
      }).api;
      await ingest.sources.addS3('claude_code', { bucket: 'b', prefix: 'logs' });
      await importAll();
      const s3Session = await ingest.sessions.get(sessionId('claude_code', 's3-session'));
      expect(s3Session).not.toBeNull();
    });

    it('refuses a plain-http S3 endpoint on another host, but allows this machine', async () => {
      await expect(
        ingest.sources.addS3('claude_code', {
          bucket: 'b',
          prefix: '',
          endpoint: 'http://minio.example:9000',
        }),
      ).rejects.toThrow(/https/);
      const local = await ingest.sources.addS3('claude_code', {
        bucket: 'b',
        prefix: '',
        endpoint: 'http://127.0.0.1:9000',
      });
      expect(local.kind).toBe('s3');
    });

    it('purges intake and S3 copies past retention, keeps pinned sessions’ files, and does not fetch them again', async () => {
      const db = t.handle.db;
      const monthAgo = new Date(Date.now() - 30 * DAY_MS);
      const lines = `${claudeSessionLines().join('\n')}\n`;
      s3Api = fakeS3Api({
        [`logs/-p/${CLAUDE_SESSION_ID}.jsonl`]: { body: lines, lastModified: monthAgo },
        'logs/-p/other-session.jsonl': { body: lines, lastModified: monthAgo },
      }).api;
      const s3 = await ingest.sources.addS3('claude_code', { bucket: 'b', prefix: 'logs' });
      expect(await ingest.syncS3()).toBe(2);
      for (const j of await db
        .selectFrom('job')
        .select('payload')
        .where('kind', '=', 'ingest_file')
        .execute())
        await ingest.handlers.ingest_file?.run({ payload: fromJson(j.payload) } as never);
      expect(await ingest.pinSession(sessionId('claude_code', CLAUDE_SESSION_ID))).toBe(true);

      const data = realpathSync(join(dir, 'data'));
      const intakeOld = join(data, 'intake', 'u1', 'claude_code', '-p', 'old.jsonl');
      const intakeFresh = join(data, 'intake', 'u1', 'claude_code', '-p', 'fresh.jsonl');
      const stalePart = join(data, 'intake', '.tmp', 'stale.part');
      const freshPart = join(data, 'intake', '.tmp', 'fresh.part');
      mkdirSync(join(data, 'intake', 'u1', 'claude_code', '-p'), { recursive: true });
      mkdirSync(join(data, 'intake', '.tmp'), { recursive: true });
      for (const f of [intakeOld, intakeFresh, stalePart, freshPart]) writeFileSync(f, 'x\n');
      utimesSync(intakeOld, monthAgo, monthAgo);
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      utimesSync(stalePart, twoHoursAgo, twoHoursAgo);
      // The user's own log folders are never touched.
      utimesSync(sources.claudeFile, monthAgo, monthAgo);

      await createSettings(db, LOCAL_WORKSPACE_ID, createSecretStore(join(dir, 'data'))).update({
        'retention.days': 7,
      });
      await ingest.handlers.purge_payloads?.run({} as never);

      const pinned = join(s3.path, '-p', `${CLAUDE_SESSION_ID}.jsonl`);
      const other = join(s3.path, '-p', 'other-session.jsonl');
      expect([pinned, intakeFresh, freshPart, sources.claudeFile].filter(existsSync)).toHaveLength(
        4,
      );
      expect([other, intakeOld, stalePart].filter(existsSync)).toEqual([]);
      // Past the retention window: the next sync leaves the purged object in the bucket.
      expect(await ingest.syncS3()).toBe(0);
      expect(existsSync(other)).toBe(false);
    });

    it('refuses an S3 source whose bucket cannot be listed, with the AWS message', async () => {
      s3Api = fakeS3Api({}, { failWith: 'Access Denied' }).api;
      await expect(
        ingest.sources.addS3('claude_code', { bucket: 'nope', prefix: '' }),
      ).rejects.toThrow(/Access Denied/);
      expect((await ingest.sources.list()).filter((s) => s.kind === 's3')).toEqual([]);
    });

    it('registers a source once and rejects missing folders', async () => {
      const again = await ingest.sources.add('claude_code', sources.claude);
      expect((await ingest.sources.list()).filter((s) => s.id === again.id)).toHaveLength(1);
      await expect(ingest.sources.add('claude_code', join(dir, 'nope'))).rejects.toThrow(
        /not a folder/,
      );
      expect(CLAUDE_SESSION_ID).not.toBe(CODEX_SESSION_ID);
    });
  });
}
