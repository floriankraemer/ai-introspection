import { sqliteTestDb } from '../../platform/testkit/db.js';
import { trendsNfrSuite } from './trends.nfr.suite.js';

trendsNfrSuite('sqlite', sqliteTestDb);
