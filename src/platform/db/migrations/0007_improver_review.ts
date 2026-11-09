import { sql, type Kysely } from 'kysely';
import { columnTypes } from '../columns.js';
import type { Dialect } from '../schema.js';

/**
 * Phase 3 review fixes: a per-repository switch for executable instruction surfaces (hooks,
 * settings, scripts), and a record of what the improver declined or failed per cluster so the same
 * sessions are not billed again within days.
 */
export async function up(db: Kysely<unknown>, dialect: Dialect): Promise<void> {
  const t = columnTypes(dialect);
  const falseDefault = dialect === 'postgres' ? sql`false` : sql`0`;
  await db.schema
    .alterTable('skill_repo')
    .addColumn('allow_executable', t.bool, (c) => c.notNull().defaultTo(falseDefault))
    .execute();
  await db.schema
    .createTable('cluster_outcome')
    .addColumn('id', t.id, (c) => c.primaryKey())
    .addColumn('workspace_id', t.id, (c) => c.notNull().references('workspace.id'))
    .addColumn('target_repo_id', t.id, (c) => c.notNull().references('skill_repo.id'))
    .addColumn('fingerprint', 'text', (c) => c.notNull())
    .addColumn('outcome', 'text', (c) => c.notNull())
    .addColumn('detail', 'text', (c) => c.notNull())
    .addColumn('at', t.timestamp, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('cluster_outcome_fingerprint')
    .on('cluster_outcome')
    .columns(['workspace_id', 'target_repo_id', 'fingerprint'])
    .execute();
}
