import type { Kysely } from 'kysely';
import { columnTypes } from '../columns.js';
import type { Dialect } from '../schema.js';

/** Ingest needs two columns 0001 did not foresee: job progress for imports, and the tool-call id that pairs a result with its call across chunks. */
export async function up(db: Kysely<unknown>, dialect: Dialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema.alterTable('job').addColumn('progress', t.json).execute();
  await db.schema.alterTable('event').addColumn('call_id', 'text').execute();
  await db.schema
    .createIndex('event_session_call')
    .on('event')
    .columns(['session_id', 'call_id'])
    .execute();
}
