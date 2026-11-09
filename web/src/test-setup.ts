import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The mock API's latency plus a refetch can outlast the 1 s default on a loaded machine.
configure({ asyncUtilTimeout: 8000 });

afterEach(cleanup);
