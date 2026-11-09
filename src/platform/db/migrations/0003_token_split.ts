import type { Kysely } from 'kysely';

/**
 * Token accounting that is exact across incremental ingests: cache reads and writes get their own
 * columns (`tokens_in` now excludes cache), and `usage_tail` remembers the last Claude message and
 * what was counted for it, because a message's log lines can straddle two ingest runs.
 * Existing rows keep their old `tokens_in` (which included cache) until their file is re-ingested.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const alter = () => db.schema.alterTable('session');
  await alter()
    .addColumn('tokens_cache_read', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
  await alter()
    .addColumn('tokens_cache_write', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
  await alter().addColumn('usage_tail', 'text').execute();
}
