import { postgresTestDb } from '../testkit/db.js';
import { intakeTokensSuite } from './intake-tokens.suite.js';

// The same suite runs against SQLite in intake-tokens.test.ts (`make test`).
intakeTokensSuite('postgres', postgresTestDb);
