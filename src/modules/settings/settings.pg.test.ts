import { postgresTestDb } from '../../platform/testkit/db.js';
import { settingsSuite } from './settings.suite.js';

// The same suite runs against SQLite in settings.test.ts (`make test`).
settingsSuite('postgres', postgresTestDb);
