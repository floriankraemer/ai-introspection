import { sql, type Kysely } from 'kysely';

/**
 * Phase 2 review fixes: a stable per-event key from the source file (so a forced re-ingest keeps
 * event ids), the model that answered next to the one that was asked for, and a status on the
 * ledger (`reserved` while a call is in flight, `ok`, `error`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('event').addColumn('source_key', 'text').execute();
  await db.schema.alterTable('grade').addColumn('answered_model', 'text').execute();
  await sql`update grade set answered_model = judge_model`.execute(db);
  await db.schema
    .alterTable('llm_call')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('ok'))
    .execute();
}
