/**
 * API selection. Dev builds talk to the fixture API until the backend is ready; set
 * `VITE_API_MOCK=0` (or delete the `DEV &&` clause for good) to use the real `/v1` API.
 * Production builds always use the real API and never bundle the mock.
 */
export const USE_MOCK_API: boolean = import.meta.env.DEV && import.meta.env.VITE_API_MOCK !== '0';
