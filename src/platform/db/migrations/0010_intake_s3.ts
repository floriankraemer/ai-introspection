import type { Kysely } from 'kysely';

/**
 * Sources that are not a local folder: sessions pushed by other people (`intake`) and S3 buckets
 * (`s3`, config as JSON in `remote`). Existing rows are folders.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('source')
    .addColumn('kind', 'text', (c) => c.notNull().defaultTo('folder'))
    .execute();
  await db.schema.alterTable('source').addColumn('remote', 'text').execute();
}
