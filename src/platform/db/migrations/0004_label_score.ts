import type { Kysely } from 'kysely';

/** A human label may carry the score the person would give, next to pass or fail. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('calibration_label').addColumn('score', 'double precision').execute();
}
