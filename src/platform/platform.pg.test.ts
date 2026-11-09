import { jobsSuite } from './testkit/jobs.suite.js';
import { migrationsSuite } from './testkit/migrations.suite.js';
import { schedulerSuite } from './testkit/scheduler.suite.js';
import { postgresTestDb } from './testkit/db.js';

// Same suites run against SQLite in platform.test.ts (`make test`).
migrationsSuite('postgres', postgresTestDb);
jobsSuite('postgres', postgresTestDb);
schedulerSuite('postgres', postgresTestDb);
