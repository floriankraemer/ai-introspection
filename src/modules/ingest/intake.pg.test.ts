import { postgresTestDb } from '../../platform/testkit/db.js';
import { intakeSuite } from './intake.suite.js';

// The same suite runs against SQLite in intake.test.ts (`make test`).
intakeSuite('postgres', postgresTestDb);
