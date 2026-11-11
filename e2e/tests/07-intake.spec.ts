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

// Tests of this file run in order (one worker): the screenshots need the S3 source that the last test removes.
test('people who push: a new token pushes, Revoke stops it', async ({ page }) => {
  await page.goto('/settings');
  const people = page.getByRole('region', { name: 'People who push' });
  await people.getByRole('button', { name: '+ Add person' }).click();
  const form = people.getByRole('form', { name: 'Add person' });
  await form.getByLabel('Name').fill('e2e-dana');
  await form.getByRole('button', { name: 'Create token' }).click();

  // The token is shown once, in a read-only field.
  const reveal = people.getByRole('group', { name: 'New token' });
  const bearer = await reveal.getByLabel('Token').inputValue();
  expect(bearer).not.toBe('');
  await reveal.getByRole('button', { name: 'Done' }).click();
  await expect(reveal).toHaveCount(0);
  await expect(people.getByText('Active')).toHaveCount(3);

  const file = `/work/extra/curl/-work-alpha/${uuid(104)}.jsonl`;
  const url = `${INTAKE}/v1/intake/logs/claude_code/-work-alpha/${uuid(104)}.jsonl`;
  const push = (): string =>
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
  expect(push()).toBe('202');
  await expect.poll(() => sessionTitles(page)).toContain('Pushed by a new person');
  await page.goto(ALL);
  await expect(page.getByRole('row').filter({ hasText: 'Pushed by a new person' })).toBeVisible();

  // Revoke: the same command is refused afterwards.
  await page.goto('/settings');
  await people.getByRole('button', { name: 'Revoke token e2e-dana' }).click();
  await expect(people.getByRole('alertdialog')).toContainText('e2e-dana can no longer push');
  await people.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(people.getByText('Revoked')).toBeVisible();
  await expect(people.getByRole('button', { name: 'Revoke token e2e-dana' })).toHaveCount(0);
  expect(push()).toBe('401');
});

test('people who push: a taken name offers another token for the same person', async ({ page }) => {
  await page.goto('/settings');
  const people = page.getByRole('region', { name: 'People who push' });
  await people.getByRole('button', { name: '+ Add person' }).click();
  const form = people.getByRole('form', { name: 'Add person' });
  await form.getByLabel('Name').fill('e2e-curl');
  await form.getByRole('button', { name: 'Create token' }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  await expect(
    form.getByRole('button', { name: 'Create another token for e2e-curl' }),
  ).toBeVisible();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
});

test('sources: Disable and Enable the Codex folder', async ({ page }) => {
  await page.goto('/settings');
  const sources = page.getByRole('region', { name: 'Sources' });
  const row = sources
    .locator('div')
    .filter({ has: page.locator('code', { hasText: 'codex' }) })
    .filter({ has: page.getByRole('button', { name: /^Remove / }) })
    .last();
  await expect(row.getByText('Polling')).toBeVisible();
  await row.getByRole('button', { name: /^Disable / }).click();
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: /^Enable / }).click();
  await expect(row.getByText('Polling')).toBeVisible();
  // A pushed source cannot be disabled.
  await expect(sources.getByRole('button', { name: /^Disable pushed/ })).toHaveCount(0);
});

// Settings with folder, pushed and S3 sources and the people who push, light and dark.
for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test('settings with pushed and S3 sources', async ({ page }) => {
      await page.goto('/settings');
      const sources = page.getByRole('region', { name: 'Sources' });
      // Only raw pushes (curl, the new person) have a folder; a --redact push writes sessions, no source.
      await expect(sources.getByText('Pushed', { exact: true })).toHaveCount(2);
      await expect(sources.getByText('Pushed by e2e-curl')).toBeVisible();
      await expect(sources.getByText('Pushed by e2e-dana')).toBeVisible();
      await expect(sources.getByText('s3://e2e-logs/claude/')).toBeVisible();
      await expect(page.getByText('Loading', { exact: false })).toHaveCount(0);
      await expect(page).toHaveScreenshot(`settings-sources-${scheme}.png`, {
        fullPage: true,
      });
    });

    test('settings people who push card', async ({ page }) => {
      await page.goto('/settings');
      const people = page.getByRole('region', { name: 'People who push' });
      await expect(people.getByText('e2e-cli')).toBeVisible();
      await expect(people.getByText('Revoked')).toBeVisible();
      await expect(people).toHaveScreenshot(`settings-people-${scheme}.png`);
    });
  });
}

test('sources: Remove the S3 bucket keeps its sessions', async ({ page }) => {
  await page.goto('/settings');
  const sources = page.getByRole('region', { name: 'Sources' });
  await sources.getByRole('button', { name: 'Remove s3://e2e-logs/claude/' }).click();
  const confirm = sources.getByRole('alertdialog');
  await expect(confirm).toContainText(
    'Remove s3://e2e-logs/claude/? Its 2 sessions stay in Introspect.',
  );
  await expect(confirm).toContainText('The copied log files are deleted.');
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(sources.getByText('s3://e2e-logs/claude/')).toHaveCount(0);

  await page.goto(ALL);
  await expect(page.getByRole('row').filter({ hasText: 'Read from the bucket' })).toBeVisible();
  expect(await sessionTitles(page)).toContain('Second bucket session');
});
