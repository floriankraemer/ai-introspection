import { defineConfig, devices } from '@playwright/test';

// Flake policy: no retries, no fixed sleeps. One worker: the specs share one app and run in order
// (see run.sh for the phases).
export default defineConfig({
  testDir: 'tests',
  snapshotDir: '__screenshots',
  snapshotPathTemplate: '{snapshotDir}/{arg}{ext}',
  outputDir: '/work/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 },
  },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:7317',
    viewport: { width: 1280, height: 860 },
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
