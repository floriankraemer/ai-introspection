import { sqliteTestDb } from '../../platform/testkit/db.js';
import { trendsSuite } from './trends.suite.js';

// The same suite runs against Postgres in trends.pg.test.ts (`make test-pg`).
trendsSuite('sqlite', sqliteTestDb);
