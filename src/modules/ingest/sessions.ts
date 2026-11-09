import { sql } from 'kysely';
import { asBool } from '../../platform/db/json.js';
import type { Db } from '../../platform/db/schema.js';
import { SAMPLE_PERCENT } from './signals.js';
import { summarize } from './trace-text.js';
import type { Agent, EventKind } from './types.js';

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
  /** Filled by the grading module's join once grading exists. */
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
  if (asBool(s.flagged)) return 'flagged, waiting for the judge (available in Phase 2)';
  if (asBool(s.sampled)) return 'sampled, waiting for the judge (available in Phase 2)';
  return `not flagged, outside ${String(SAMPLE_PERCENT)}% sample`;
}

export function createSessionQueries(db: Db, workspaceId: string) {
  return {
    async list(q: SessionQuery): Promise<Page<SessionSummary>> {
      // No grades exist before Phase 2, so "failed any" is empty and "not graded" is everything.
      if (q.result === 'failed_any') return { items: [], nextCursor: null };
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
          'signal.failed_tool_calls',
        ])
        .where('session.workspace_id', '=', workspaceId);
      if (q.agent) qb = qb.where('session.agent', '=', q.agent);
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
      q: { filter: EventFilter; cursor?: number | undefined; limit: number },
    ): Promise<(Page<TraceEvent> & { total: number }) | null> {
      const session = await db
        .selectFrom('session')
        .select(['started_at', 'created_at'])
        .where('id', '=', id)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      if (!session) return null;
      // Evidence ids come from grades, which exist from Phase 2.
      if (q.filter === 'evidence') return { items: [], nextCursor: null, total: 0 };
      const base = db.selectFrom('event').where('session_id', '=', id);
      const filtered = q.filter === 'errors' ? base.where('is_error', '=', true) : base;
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
