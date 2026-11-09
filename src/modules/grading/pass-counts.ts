import { PostgresAdapter, sql } from 'kysely';
import type { Db } from '../../platform/db/schema.js';

export interface PassCount {
  rubric: string;
  /** `floor(epoch / slotSeconds)` of the session start; 0 when not asked for. */
  slot: number;
  graded: number;
  passed: number;
}

export interface PassCountQuery {
  /** Sessions that started at or after this instant. */
  from: Date;
  /** ... and before this one (open end when omitted). */
  to?: Date | undefined;
  /** Only these rubrics; all when omitted. */
  names?: readonly string[] | undefined;
  /**
   * Group by slots of this many seconds of the session start (trend buckets) instead of one row
   * per rubric. Use the largest slot that divides every offset of the time zone: 3600 for most zones, 900 for all.
   */
  slotSeconds?: number;
}

/** The newest `ok` grade of each session and rubric name among sessions that started in the range. */
function newestOk(
  workspaceId: string,
  from: Date,
  to: Date | undefined,
  names?: readonly string[],
) {
  const upper = to ? sql`and s.started_at < ${to.toISOString()}` : sql``;
  const only = names ? sql`and r.name in (${sql.join(names)})` : sql``;
  return sql`(
    select r.name as name, g.passed as passed, s.started_at as started_at,
      row_number() over (
        partition by g.session_id, r.name order by g.graded_at desc, g.id desc
      ) as rn
    from session s
    cross join grade g
    cross join rubric r
    where s.workspace_id = ${workspaceId} and g.workspace_id = ${workspaceId}
      and g.session_id = s.id and r.id = g.rubric_id and g.status = 'ok'
      and s.started_at >= ${from.toISOString()} ${upper} ${only}
  )`;
}

const isPostgres = (db: Db): boolean => db.getExecutor().adapter instanceof PostgresAdapter;

/**
 * The one definition of "pass rate" (NFR-05): the newest `ok` grade of each session and rubric name,
 * counted by the session's start. Stale, invalid and refused grades never count. Window functions
 * run on SQLite 3.25+ and Postgres; the work stays in the database and returns one row per rubric
 * and slot, however many grades there are. `cross join` keeps SQLite from starting at the grades
 * (it has no statistics): the sessions of the range come first, from `session_workspace_started`.
 */
export async function passCounts(
  db: Db,
  workspaceId: string,
  q: PassCountQuery,
): Promise<PassCount[]> {
  if (q.names?.length === 0) return [];
  const size = q.slotSeconds ?? 0;
  const slotOf = isPostgres(db)
    ? sql`cast(floor(extract(epoch from x.started_at) / ${sql.lit(size)}) as integer)`
    : sql`cast(strftime('%s', x.started_at) as integer) / ${sql.lit(size)}`;
  const slot = size > 0 ? sql`${slotOf} as slot` : sql`0 as slot`;
  const groupBy = size > 0 ? sql`group by x.name, slot` : sql`group by x.name`;
  const { rows } = await sql<PassCount>`
    select x.name as rubric, ${slot},
      cast(count(*) as integer) as graded,
      cast(sum(case when x.passed then 1 else 0 end) as integer) as passed
    from ${newestOk(workspaceId, q.from, q.to, q.names)} x
    where x.rn = 1
    ${groupBy}
  `.execute(db);
  return rows;
}

export interface RangeCount {
  /** Echoed back, so a caller can ask for many windows at once. */
  key: string;
  rubric: string;
  /** Sessions that started at or after `from` and before `to`. */
  from: Date;
  to: Date;
}

/**
 * `passCounts` for many (rubric, window) pairs in one pass over the grades: the change log compares
 * two windows for each of dozens of changes. Returns the totals per key.
 */
export async function passCountsInRanges(
  db: Db,
  workspaceId: string,
  ranges: readonly RangeCount[],
): Promise<Map<string, { graded: number; passed: number }>> {
  const out = new Map<string, { graded: number; passed: number }>();
  const live = ranges.filter((r) => r.to > r.from);
  if (live.length === 0) return out;
  const time = sql.raw(isPostgres(db) ? 'timestamptz' : 'text');
  const values = sql.join(
    live.map(
      (r) =>
        sql`(cast(${r.key} as text), cast(${r.rubric} as text), cast(${r.from.toISOString()} as ${time}), cast(${r.to.toISOString()} as ${time}))`,
    ),
  );
  const first = new Date(Math.min(...live.map((r) => r.from.getTime())));
  const last = new Date(Math.max(...live.map((r) => r.to.getTime())));
  const { rows } = await sql<{ key: string; graded: number; passed: number }>`
    with w(k, name, f, t) as (values ${values})
    select w.k as key, cast(count(*) as integer) as graded,
      cast(sum(case when x.passed then 1 else 0 end) as integer) as passed
    from ${newestOk(workspaceId, first, last)} x
    join w on w.name = x.name and x.started_at >= w.f and x.started_at < w.t
    where x.rn = 1
    group by w.k
  `.execute(db);
  for (const r of rows) out.set(r.key, { graded: r.graded, passed: r.passed });
  return out;
}

/** Sessions with at least one counted grade, same filter as `passCounts`. */
export async function gradedSessionCount(db: Db, workspaceId: string, from: Date): Promise<number> {
  const row = await db
    .selectFrom('grade')
    .innerJoin('session', 'session.id', 'grade.session_id')
    .select((eb) => eb.fn.count<number>('grade.session_id').distinct().as('n'))
    .where('grade.workspace_id', '=', workspaceId)
    .where('grade.status', '=', 'ok')
    .where('session.started_at', '>=', from.toISOString())
    .executeTakeFirstOrThrow();
  return row.n;
}
