import type { Kysely } from 'kysely';

/**
 * Trends review fixes: where a grade came from (reference re-grades must not rewrite history), and
 * the last problem the change scan had with a repository (shown by the doctor).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('grade')
    .addColumn('origin', 'text', (c) => c.notNull().defaultTo('standard'))
    .execute();
  await db.schema.alterTable('skill_repo').addColumn('scan_warning', 'text').execute();
}
