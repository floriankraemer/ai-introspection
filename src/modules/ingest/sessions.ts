import { sql } from 'kysely';
import { asBool } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';
import { SAMPLE_PERCENT } from './signals.js';
import { summarize } from './trace-text.js';
import type { Agent, EventKind, GradeCandidate, RedactedTrace, TraceRecord } from './types.js';

export type SessionResultFilter = 'failed_any' | 'all' | 'not_graded';
export type EventFilter = 'all' | 'errors' | 'evidence';

export interface SessionQuery {
  q?: string | undefined;
  agent?: Agent | undefined;
  result?: SessionResultFilter | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  agent: Agent;
  repo: string | null;
  startedAt: string;
  toolErrors: number;
  /** `tokensIn` is fresh input only; cache reads and writes are separate. */
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /** Empty here; the grading module fills it in (`grading.sessions`). */
  grades: { rubric: string; passed: boolean | null; score: number | null }[];
  notGradedReason: string | null;
}

export interface SessionDetail {
  id: string;
  title: string;
  agent: Agent;
  repo: string | null;
  branch: string | null;
  startedAt: string;
  durationS: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  model: string | null;
  outcome: {
    kind: 'none' | 'commit' | 'pr_open' | 'pr_merged';
    ref: string | null;
    url: string | null;
  };
  eventCount: number;
  errorCount: number;
}

export interface TraceEvent {
  id: string;
  seq: number;
  offsetS: number;
  kind: EventKind;
  name: string | null;
  text: string;
  isError: boolean;
  input: string | null;
  output: string | null;
  truncated: boolean;
  payloadPurged: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const encodeCursor = (startedAt: string, id: string): string =>
  Buffer.from(`${startedAt}|${id}`).toString('base64url');

function decodeCursor(cursor: string): { startedAt: string; id: string } | undefined {
  const [startedAt, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  return startedAt && id ? { startedAt, id } : undefined;
}

const likePattern = (q: string): string => `%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;

function notGradedReason(s: {
  status: string;
  flagged: boolean | number;
  sampled: boolean | number;
}): string {
  if (s.status === 'active') return 'session still running';
  if (asBool(s.flagged)) return 'flagged, waiting for the judge';
  if (asBool(s.sampled)) return 'sampled, waiting for the judge';
  return `not flagged, outside ${String(SAMPLE_PERCENT)}% sample`;
}

/**
 * Read-only filter over the grading tables (`grade`, `rubric`); the ingest module imports no
 * grading code. A session "failed any" when the newest grade of some rubric is a failing one.
 */
const FAILED_ANY = sql<boolean>`session.id in (
  select g.session_id from grade g join rubric r on r.id = g.rubric_id
  where g.passed = false and g.status = 'ok' and not exists (
    select 1 from grade g2 join rubric r2 on r2.id = g2.rubric_id
    where g2.session_id = g.session_id and r2.name = r.name and g2.graded_at > g.graded_at))`;
const NOT_GRADED = sql<boolean>`not exists (
  select 1 from grade g where g.session_id = session.id and g.status = 'ok')`;

export function createSessionQueries(db: Db, workspaceId: string) {
  return {
    async list(q: SessionQuery): Promise<Page<SessionSummary>> {
      let qb = db
        .selectFrom('session')
        .leftJoin('signal', 'signal.session_id', 'session.id')
        .select([
          'session.id',
          'session.title',
          'session.agent',
          'session.repo',
          'session.started_at',
          'session.created_at',
          'session.status',
          'session.flagged',
          'session.sampled',
          'session.tokens_in',
          'session.tokens_out',
          'session.tokens_cache_read',
          'session.tokens_cache_write',
          'signal.failed_tool_calls',
        ])
        .where('session.workspace_id', '=', workspaceId);
      if (q.agent) qb = qb.where('session.agent', '=', q.agent);
      if (q.result === 'failed_any') qb = qb.where(FAILED_ANY);
      if (q.result === 'not_graded') qb = qb.where(NOT_GRADED);
      if (q.q) {
        const pattern = likePattern(q.q);
        qb = qb.where(
          sql<boolean>`(lower(coalesce(session.title, '')) like ${pattern} escape '\\' or lower(coalesce(session.repo, '')) like ${pattern} escape '\\')`,
        );
      }
      const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
      if (cursor) {
        qb = qb.where((eb) =>
          eb.or([
            eb('session.started_at', '<', cursor.startedAt),
            eb.and([
              eb('session.started_at', '=', cursor.startedAt),
              eb('session.id', '<', cursor.id),
            ]),
          ]),
        );
      }
      const rows = await qb
        .orderBy('session.started_at', 'desc')
        .orderBy('session.id', 'desc')
        .limit(q.limit + 1)
        .execute();
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          id: r.id,
          title: r.title ?? 'Untitled session',
          agent: r.agent as Agent,
          repo: r.repo,
          startedAt: r.started_at ?? r.created_at,
          toolErrors: r.failed_tool_calls ?? 0,
          tokensIn: r.tokens_in,
          tokensOut: r.tokens_out,
          tokensCacheRead: r.tokens_cache_read,
          tokensCacheWrite: r.tokens_cache_write,
          grades: [],
          notGradedReason: notGradedReason(r),
        })),
        nextCursor:
          rows.length > q.limit && last ? encodeCursor(last.started_at ?? '', last.id) : null,
      };
    },

    async get(id: string): Promise<SessionDetail | null> {
      const s = await db
        .selectFrom('session')
        .selectAll()
        .where('id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      if (!s) return null;
      const counts = await db
        .selectFrom('event')
        .select([
          sql<number>`count(*)`.as('total'),
          sql<number>`count(*) filter (where is_error)`.as('errors'),
        ])
        .where('session_id', '=', id)
        .executeTakeFirstOrThrow();
      return {
        id: s.id,
        title: s.title ?? 'Untitled session',
        agent: s.agent as Agent,
        repo: s.repo,
        branch: s.branch,
        startedAt: s.started_at ?? s.created_at,
        durationS: s.duration_s ?? 0,
        tokensIn: s.tokens_in,
        tokensOut: s.tokens_out,
        tokensCacheRead: s.tokens_cache_read,
        tokensCacheWrite: s.tokens_cache_write,
        model: s.model,
        outcome: {
          kind: s.outcome_kind,
          ref: s.outcome_ref,
          url: s.outcome_ref?.startsWith('http') ? s.outcome_ref : null,
        },
        eventCount: counts.total,
        errorCount: counts.errors,
      };
    },

    async events(
      id: string,
      q: {
        filter: EventFilter;
        cursor?: number | undefined;
        limit: number;
        /** Event ids that count as evidence; the grading module supplies them for `filter: 'evidence'`. */
        evidenceIds?: readonly string[] | undefined;
      },
    ): Promise<(Page<TraceEvent> & { total: number }) | null> {
      const session = await db
        .selectFrom('session')
        .select(['started_at', 'created_at'])
        .where('id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      if (!session) return null;
      if (q.filter === 'evidence' && !q.evidenceIds?.length)
        return { items: [], nextCursor: null, total: 0 };
      const base = db.selectFrom('event').where('session_id', '=', id);
      const filtered =
        q.filter === 'errors'
          ? base.where('is_error', '=', true)
          : q.filter === 'evidence'
            ? base.where('id', 'in', [...(q.evidenceIds ?? [])])
            : base;
      const { n: total } = await filtered
        .select(sql<number>`count(*)`.as('n'))
        .executeTakeFirstOrThrow();
      const rows = await filtered
        .selectAll()
        .where('seq', '>', q.cursor ?? -1)
        .orderBy('seq')
        .limit(q.limit + 1)
        .execute();
      const page = rows.slice(0, q.limit);
      const startMs = Date.parse(session.started_at ?? session.created_at);
      return {
        items: page.map((e) => ({
          id: e.id,
          seq: e.seq,
          offsetS: e.ts ? Math.max(0, Math.round((Date.parse(e.ts) - startMs) / 1000)) : 0,
          kind: e.kind as EventKind,
          name: e.name,
          text: summarize(e),
          isError: asBool(e.is_error),
          input: e.input,
          output: e.output,
          truncated: asBool(e.truncated),
          payloadPurged: e.payload_purged_at !== null,
        })),
        nextCursor: rows.length > q.limit ? String(page.at(-1)?.seq) : null,
        total,
      };
    },

    /** Local source file of a session, for "Open raw JSONL". */
    async rawPath(id: string): Promise<string | null> {
      const row = await db
        .selectFrom('ingest_cursor')
        .select('file_path')
        .where('session_id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      return row?.file_path ?? null;
    },

    /** Ended sessions with the facts the grading policy decides on. `ids` narrows to those sessions and ignores `since`. */
    async gradeCandidates(q: {
      ids?: readonly string[];
      since?: Date;
      limit?: number;
    }): Promise<GradeCandidate[]> {
      let qb = db
        .selectFrom('session')
        .leftJoin('signal', 'signal.session_id', 'session.id')
        .select([
          'session.id',
          'session.agent',
          'session.status',
          'session.flagged',
          'session.sampled',
          'session.outcome_kind',
          'session.started_at',
          'session.created_at',
          'signal.failed_tool_calls',
          'signal.tests_run',
        ])
        .where('session.workspace_id', '=', workspaceId)
        .orderBy('session.started_at', 'desc')
        .orderBy('session.id', 'desc');
      if (q.ids) {
        if (q.ids.length === 0) return [];
        qb = qb.where('session.id', 'in', [...q.ids]);
      } else {
        qb = qb.where('session.status', '=', 'ended');
        if (q.since) qb = qb.where('session.started_at', '>=', q.since.toISOString());
      }
      if (q.limit) qb = qb.limit(q.limit);
      return (await qb.execute()).map((r) => ({
        id: r.id,
        agent: r.agent as Agent,
        status: r.status,
        flagged: asBool(r.flagged),
        sampled: asBool(r.sampled),
        outcomeKind: r.outcome_kind,
        startedAt: r.started_at ?? r.created_at,
        failedToolCalls: r.failed_tool_calls ?? 0,
        testsRun: r.tests_run ?? 0,
      }));
    },

    /**
     * The redacted trace for the judge. Payloads are cut to their head and tail here, page by page,
     * so a huge session never sits in memory in full.
     */
    async traceFor(
      id: string,
      cut: { headChars: number; tailChars: number },
    ): Promise<RedactedTrace | null> {
      const s = await db
        .selectFrom('session')
        .select(['agent', 'title'])
        .where('id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      if (!s) return null;
      const shorten = (text: string | null): string | null => {
        if (text === null || text.length <= cut.headChars + cut.tailChars) return text;
        const omitted = text.length - cut.headChars - cut.tailChars;
        return `${text.slice(0, cut.headChars)}\n[${String(omitted)} characters omitted]\n${text.slice(-cut.tailChars)}`;
      };
      const events: TraceRecord[] = [];
      let after = -1;
      for (;;) {
        const page = await db
          .selectFrom('event')
          .selectAll()
          .where('session_id', '=', id)
          .where('seq', '>', after)
          .orderBy('seq')
          .limit(500)
          .execute();
        for (const e of page) {
          events.push({
            id: e.id,
            seq: e.seq,
            ts: e.ts,
            kind: e.kind as EventKind,
            name: e.name,
            summary: summarize(e),
            input: shorten(e.input),
            output: shorten(e.output),
            isError: asBool(e.is_error),
          });
        }
        const last = page.at(-1);
        if (!last || page.length < 500) break;
        after = last.seq;
      }
      return {
        sessionId: id,
        agent: s.agent as Agent,
        title: s.title ?? 'Untitled session',
        events,
      } as RedactedTrace;
    },

    async countStartedSince(since: Date): Promise<number> {
      const row = await db
        .selectFrom('session')
        .select(sql<number>`count(*)`.as('n'))
        .where('workspace_id', '=', workspaceId)
        .where('started_at', '>=', since.toISOString())
        .executeTakeFirstOrThrow();
      return row.n;
    },
  };
}
