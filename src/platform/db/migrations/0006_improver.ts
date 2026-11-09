import type { Kysely } from 'kysely';

/**
 * Phase 3: what an improver run saw and decided (clusters, excluded untrusted rubrics, skipped
 * sessions) and the cluster a proposal answers. Plain JSON text on both dialects.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('improver_run').addColumn('summary', 'text').execute();
  await db.schema.alterTable('improver_run').addColumn('error', 'text').execute();
  await db.schema.alterTable('proposal').addColumn('cluster_summary', 'text').execute();
  await db.schema.alterTable('proposal').addColumn('merge_commit', 'text').execute();
}
