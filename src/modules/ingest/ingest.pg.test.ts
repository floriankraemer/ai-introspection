import { postgresTestDb } from '../../platform/testkit/db.js';
import { ingestSuite } from './ingest.suite.js';

// The same suite runs against SQLite in ingest.test.ts (`make test`).
ingestSuite('postgres', postgresTestDb);
