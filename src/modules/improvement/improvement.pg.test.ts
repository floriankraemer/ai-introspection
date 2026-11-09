import { postgresTestDb } from '../../platform/testkit/db.js';
import { improvementSuite } from './improvement.suite.js';

// The same suite runs against SQLite in improvement.test.ts (`make test`).
improvementSuite('postgres', postgresTestDb);
