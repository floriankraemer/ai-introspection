import { postgresTestDb } from '../../platform/testkit/db.js';
import { trendsNfrSuite } from './trends.nfr.suite.js';

trendsNfrSuite('postgres', postgresTestDb);
