import { postgresTestDb } from '../../platform/testkit/db.js';
import { gradingSuite } from './grading.suite.js';

// The same suite runs against SQLite in grading.test.ts (`make test`).
gradingSuite('postgres', postgresTestDb);
