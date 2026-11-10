import { sqliteTestDb } from '../../platform/testkit/db.js';
import { intakeSuite } from './intake.suite.js';

// The same suite runs against Postgres in intake.pg.test.ts (`make test-pg`).
intakeSuite('sqlite', sqliteTestDb);
