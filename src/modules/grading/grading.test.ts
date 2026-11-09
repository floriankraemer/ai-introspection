import { sqliteTestDb } from '../../platform/testkit/db.js';
import { gradingSuite } from './grading.suite.js';

// The same suite runs against Postgres in grading.pg.test.ts (`make test-pg`).
gradingSuite('sqlite', sqliteTestDb);
