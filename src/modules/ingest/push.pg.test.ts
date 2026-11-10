import { postgresTestDb } from '../../platform/testkit/db.js';
import { pushSuite } from './push.suite.js';

// The same suite runs against SQLite in push.test.ts (`make test`).
pushSuite('postgres', postgresTestDb);
