import { sqliteTestDb } from '../../platform/testkit/db.js';
import { settingsSuite } from './settings.suite.js';

// The same suite runs against Postgres in settings.pg.test.ts (`make test-pg`).
settingsSuite('sqlite', sqliteTestDb);
