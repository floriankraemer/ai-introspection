import { sqliteTestDb } from '../../platform/testkit/db.js';
import { pushSuite } from './push.suite.js';

// The same suite runs against Postgres in push.pg.test.ts (`make test-pg`).
pushSuite('sqlite', sqliteTestDb);
