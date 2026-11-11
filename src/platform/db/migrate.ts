import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import { sql } from 'kysely';
import type { DbHandle } from './connection.js';
import * as initial from './migrations/0001_initial.js';
import * as ingest from './migrations/0002_ingest.js';
import * as tokenSplit from './migrations/0003_token_split.js';
import * as labelScore from './migrations/0004_label_score.js';
import * as reviewFixes from './migrations/0005_review_fixes.js';
import * as improver from './migrations/0006_improver.js';
import * as improverReview from './migrations/0007_improver_review.js';
import * as trends from './migrations/0008_trends.js';
import * as trendsReview from './migrations/0009_trends_review.js';
import * as intakeS3 from './migrations/0010_intake_s3.js';
import * as sessionOrigin from './migrations/0011_session_origin.js';

/** Migrations are bundled (not read from a folder) so tsx, tsc output and tests all find them. */
export async function migrateToLatest({ db, dialect }: DbHandle): Promise<void> {
  // Kysely looks for its bookkeeping tables in every schema; pin them to the one this connection uses,
  // or a second schema in the same database (parallel tests, team installs) would wrongly look migrated.
  const migrationTableSchema =
    dialect === 'postgres'
      ? (await sql<{ schema: string }>`select current_schema() as schema`.execute(db)).rows[0]
          ?.schema
      : undefined;
  const migrations: Record<string, Migration> = {
    '0001_initial': { up: (k) => initial.up(k, dialect) },
    '0002_ingest': { up: (k) => ingest.up(k, dialect) },
    '0003_token_split': { up: (k) => tokenSplit.up(k) },
    '0004_label_score': { up: (k) => labelScore.up(k) },
    '0005_review_fixes': { up: (k) => reviewFixes.up(k) },
    '0006_improver': { up: (k) => improver.up(k) },
    '0007_improver_review': { up: (k) => improverReview.up(k, dialect) },
    '0008_trends': { up: (k) => trends.up(k) },
    '0009_trends_review': { up: (k) => trendsReview.up(k) },
    '0010_intake_s3': { up: (k) => intakeS3.up(k) },
    '0011_session_origin': { up: (k) => sessionOrigin.up(k) },
  };
  const provider: MigrationProvider = { getMigrations: () => Promise.resolve(migrations) };
  const { error } = await new Migrator({
    db,
    provider,
    ...(migrationTableSchema && { migrationTableSchema }),
  }).migrateToLatest();
  if (error) throw new Error('Database migration failed', { cause: error });
}
