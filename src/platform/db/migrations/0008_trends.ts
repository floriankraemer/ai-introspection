import type { Kysely } from 'kysely';

/**
 * Phase 4 (trends): the last commit of each repository's default branch that the change scan saw,
 * a key that makes every detected change event idempotent, and an index for the newest-grade lookup of the change scan.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('skill_repo').addColumn('last_seen_sha', 'text').execute();
  await db.schema.alterTable('change_event').addColumn('ref', 'text').execute();
  // Proposal events have no ref (NULLs never collide); detected events are keyed by commit, rubric version or judge pair.
  await db.schema
    .createIndex('change_event_ref')
    .on('change_event')
    .columns(['workspace_id', 'kind', 'ref'])
    .unique()
    .execute();
  await db.schema
    .createIndex('change_event_at')
    .on('change_event')
    .columns(['workspace_id', 'at'])
    .execute();
  // Only graded_at: with a workspace_id prefix SQLite picks it for the trend join and scans every grade.
  await db.schema.createIndex('grade_graded_at').on('grade').column('graded_at').execute();
}
