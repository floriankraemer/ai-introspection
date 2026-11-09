import { postgresTestDb } from '../../platform/testkit/db.js';
import { trendsSuite } from './trends.suite.js';

// The same suite runs against SQLite in trends.test.ts (`make test`).
trendsSuite('postgres', postgresTestDb);
