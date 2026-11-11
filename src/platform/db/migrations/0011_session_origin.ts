import { sql, type Kysely } from 'kysely';

/**
 * How a session got here: ingested from a raw log file (`file`) or pushed client-redacted through
 * the intake (`pushed`). It used to be inferred from whether a cursor referenced the session, which
 * breaks once a source (and its cursors) is removed. Existing cursorless sessions were pushed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('session')
    .addColumn('origin', 'text', (c) => c.notNull().defaultTo('file'))
    .execute();
  await sql`update session set origin = 'pushed'
    where not exists (select 1 from ingest_cursor where ingest_cursor.session_id = session.id)`.execute(
    db,
  );
}
