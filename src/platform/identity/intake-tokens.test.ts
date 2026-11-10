import { sqliteTestDb } from '../testkit/db.js';
import { intakeTokensSuite } from './intake-tokens.suite.js';

// The same suite runs against Postgres in intake-tokens.pg.test.ts (`make test-pg`).
intakeTokensSuite('sqlite', sqliteTestDb);
