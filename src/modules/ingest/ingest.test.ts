import { sqliteTestDb } from '../../platform/testkit/db.js';
import { ingestSuite } from './ingest.suite.js';

// The same suite runs against Postgres in ingest.pg.test.ts (`make test-pg`).
ingestSuite('sqlite', sqliteTestDb);
