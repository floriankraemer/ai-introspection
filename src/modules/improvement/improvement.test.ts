import { sqliteTestDb } from '../../platform/testkit/db.js';
import { improvementSuite } from './improvement.suite.js';

// The same suite runs against Postgres in improvement.pg.test.ts (`make test-pg`).
improvementSuite('sqlite', sqliteTestDb);
