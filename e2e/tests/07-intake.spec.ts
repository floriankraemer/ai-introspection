import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { allSessions, expect, test } from './support.ts';

// Flow 7: sessions that do not come from a local folder. run.sh created the two intake tokens, ran
// `introspect push` and uploaded the bucket fixtures before this spec starts (it needs the app image).
//   - curl with a token: the documented way for anybody to push one raw log.
//   - `introspect push --redact`: redacted on the pusher's side (already run by run.sh, see push.log).
//   - S3: Settings -> Sources -> Add S3 bucket against MinIO.
const INTAKE = 'http://127.0.0.1:7318';
// Pushed sessions are not graded, so the default view (failed any rubric) would hide them.
const ALL = '/?result=all&range=all';
const uuid = (i: number): string => `e2e00000-0000-4000-8000-${String(i).padStart(12, '0')}`;

const sessionTitles = async (page: Page): Promise<string[]> =>
  (await allSessions(page.request)).map((s) => s.title);

test('intake: a log pushed with curl shows on Sessions', async ({ page }) => {
  const token = readFileSync('/work/intake/curl.token', 'utf8').trim();
  const file = `/work/extra/curl/-work-alpha/${uuid(100)}.jsonl`;
  const url = `${INTAKE}/v1/intake/logs/claude_code/-work-alpha/${uuid(100)}.jsonl`;
  // The command of the manual, as the person pushing would type it.
  const push = (bearer: string): string =>
    execFileSync(
      'sh',
      [
        '-c',
        `gzip -c "${file}" | curl -sS -o /dev/null -w '%{http_code}' -X PUT ` +
          `-H "Authorization: Bearer ${bearer}" -H "Content-Type: application/x-ndjson" ` +
          `-H "Content-Encoding: gzip" --data-binary @- "${url}"`,
      ],
      { encoding: 'utf8' },
    );

  // A wrong token is refused and leaves nothing behind.
  expect(push('not-a-token')).toBe('401');
  expect(await sessionTitles(page)).not.toContain('Pushed with curl');

  expect(push(token)).toBe('202');
  await expect.poll(() => sessionTitles(page)).toContain('Pushed with curl');

  await page.goto(ALL);
  await page.getByRole('row').filter({ hasText: 'Pushed with curl' }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Pushed with curl' })).toBeVisible();
  await expect(page.getByText('Done. The change is in place.').first()).toBeVisible();
  await expect(page.getByText('Pushed by e2e-curl')).toBeVisible();
});

test('intake: introspect push --redact shows on Sessions', async ({ page }) => {
  // Output of the client run by run.sh.
  expect(readFileSync('/work/intake/push.log', 'utf8')).toContain(
    'pushed 1, unchanged 0, failed 0',
  );

  await expect.poll(() => sessionTitles(page)).toContain('Pushed with the CLI');
  await page.goto(ALL);
  await page.getByRole('row').filter({ hasText: 'Pushed with the CLI' }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Pushed with the CLI' })).toBeVisible();
  await expect(page.getByText('Done. The change is in place.').first()).toBeVisible();
  await expect(page.getByText('Pushed by e2e-cli')).toBeVisible();
});

test('sessions: Person column and filter', async ({ page }) => {
  await page.goto(ALL);
  const row = (title: string) => page.getByRole('row').filter({ hasText: title });
  await expect(page.getByRole('columnheader', { name: 'Person' })).toBeVisible();
  await expect(row('Pushed with curl').getByText('e2e-curl')).toBeVisible();
  await expect(row('Pushed with the CLI').getByText('e2e-cli')).toBeVisible();

  await page.getByLabel('Person').selectOption({ label: 'e2e-cli' });
  await expect(row('Pushed with the CLI')).toBeVisible();
  await expect(row('Pushed with curl')).toHaveCount(0);
  await expect(row('Add the orders endpoint')).toHaveCount(0);
});

test('s3: add a bucket in Settings, its sessions appear', async ({ page }) => {
  await page.goto('/settings');
  const sources = page.getByRole('region', { name: 'Sources' });
  const form = sources.getByRole('form', { name: 'Add S3 bucket' });
  const fill = async (bucket: string): Promise<void> => {
    await form.getByLabel('Bucket').fill(bucket);
    await form.getByLabel('Prefix (optional)').fill('claude/');
    await form.getByLabel('Endpoint (optional)').fill('http://minio:9000');
    await form.getByRole('checkbox', { name: 'Use path-style addressing' }).check();
  };

  // A bucket that does not exist: the form stays open and says why.
  await sources.getByRole('button', { name: '+ Add S3 bucket' }).click();
  await fill('no-such-bucket');
  await form.getByRole('button', { name: 'Add bucket' }).click();
  await expect(form.getByRole('alert')).toContainText('Cannot read s3://no-such-bucket/claude/');
  await expect(sources.locator('code', { hasText: 's3://no-such-bucket/claude/' })).toHaveCount(0);

  // The right bucket: the row shows the S3 badge and the location.
  await form.getByLabel('Bucket').fill('e2e-logs');
  await form.getByRole('button', { name: 'Add bucket' }).click();
  const row = sources
    .locator('div')
    .filter({ has: page.locator('code', { hasText: 's3://e2e-logs/claude/' }) })
    .last();
  await expect(row.getByText('S3', { exact: true })).toBeVisible();
  await expect(row.getByText('s3://e2e-logs/claude/')).toBeVisible();
  await expect(form).toHaveCount(0);

  await expect
    .poll(() => sessionTitles(page), { timeout: 30_000 })
    .toEqual(expect.arrayContaining(['Read from the bucket', 'Second bucket session']));
  await page.goto(ALL);
  await page.getByRole('row').filter({ hasText: 'Read from the bucket' }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Read from the bucket' })).toBeVisible();
});

// Settings with folder, pushed and S3 sources, light and dark.
for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test('settings with pushed and S3 sources', async ({ page }) => {
      await page.goto('/settings');
      const sources = page.getByRole('region', { name: 'Sources' });
      // Only the raw push (curl) has a folder; a --redact push writes sessions, no source.
      await expect(sources.getByText('Pushed', { exact: true })).toHaveCount(1);
      await expect(sources.getByText('Pushed by e2e-curl')).toBeVisible();
      await expect(sources.getByText('s3://e2e-logs/claude/')).toBeVisible();
      await expect(page.getByText('Loading', { exact: false })).toHaveCount(0);
      await expect(page).toHaveScreenshot(`settings-sources-${scheme}.png`, {
        fullPage: true,
      });
    });
  });
}
