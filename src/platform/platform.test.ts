import { jobsSuite } from './testkit/jobs.suite.js';
import { migrationsSuite } from './testkit/migrations.suite.js';
import { schedulerSuite } from './testkit/scheduler.suite.js';
import { sqliteTestDb } from './testkit/db.js';

// Same suites run against Postgres in platform.pg.test.ts (`make test-pg`).
migrationsSuite('sqlite', sqliteTestDb);
jobsSuite('sqlite', sqliteTestDb);
schedulerSuite('sqlite', sqliteTestDb);
