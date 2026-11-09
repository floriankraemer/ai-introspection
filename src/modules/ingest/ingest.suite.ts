import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromJson } from '../../platform/db/json.js';
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from '../../platform/identity/index.js';
import { createJobQueue } from '../../platform/jobs/queue.js';
import type { TestDb, TestDbFactory } from '../../platform/testkit/db.js';
import { createSecretStore, createSettings } from '../settings/index.js';
import { createIngest, type IngestService } from './index.js';
import {
  CLAUDE_SESSION_ID,
  CLAUDE_TOKENS,
  claudeSessionLines,
  CODEX_SESSION_ID,
  PLANTED,
  writeFixtureSources,
} from '../../platform/testkit/agent-fixtures.js';

const TABLES = ['session', 'event', 'signal', 'ingest_cursor', 'source', 'setting', 'job'] as const;

export function ingestSuite(name: string, make: TestDbFactory): void {
  describe(`ingest (${name})`, () => {
    let t: TestDb;
    let dir: string;
    let ingest: IngestService;
    let sources: { claude: string; codex: string; claudeFile: string };

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
        tokensIn: 500,
        tokensOut: 60,
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
      expect(session.redaction_version).toBe('1');
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
      const purged = await ingest.purgePayloads(30);
      expect(purged).toBeGreaterThan(0);
      const page = await ingest.sessions.events(claude, { filter: 'all', limit: 500 });
      expect(
        page?.items.every((e) => e.payloadPurged && e.input === null && e.output === null),
      ).toBe(true);
      expect(page?.total).toBeGreaterThan(0);
      const pinned = await ingest.sessions.events(codex, { filter: 'all', limit: 500 });
      expect(pinned?.items.some((e) => e.payloadPurged)).toBe(false);
      expect((await ingest.sessions.get(claude))?.title).toContain('Fix the failing build');
    });

    it('keeps recent sessions when the window is long enough', async () => {
      await importAll();
      const oldDate = new Date('2020-01-01');
      utimesSync(sources.claudeFile, oldDate, oldDate);
      expect(await ingest.purgePayloads(100_000)).toBe(0);
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
