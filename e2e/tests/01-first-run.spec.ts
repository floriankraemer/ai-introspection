import { expect, test } from '@playwright/test';
import { PLANTED } from '../vendor/agent-fixtures.ts';
import { allSessions, get, send, token } from './support.ts';

// Flow 1: the very first start. Sign in with the link, finish the wizard, see the sessions.
test('first run: sign in, wizard, import, redaction', async ({ page }) => {
  // Not signed in: the page says how to get the link.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Open Introspect with its link' })).toBeVisible();

  // The link `introspect open` prints. The token travels in the fragment and is removed again.
  await page.goto(`/auth#${token()}`);
  await expect(page.getByRole('heading', { name: 'Where are your sessions?' })).toBeVisible();
  expect(page.url()).not.toContain(token());

  // Quiet the background sweep: only sessions with a merged pull request are graded on their own.
  await send(page.request, 'patch', '/v1/settings', { 'schedule.grade': 'pr_merge' });

  // Step 1: both folders found, with their session counts.
  const claude = page.getByRole('checkbox', { name: /Claude Code/ });
  await expect(claude).toBeChecked();
  await expect(page.getByText('/sources/claude/projects')).toBeVisible();
  await expect(page.getByText('35 sessions')).toBeVisible();
  await expect(page.getByText('/sources/codex/sessions')).toBeVisible();
  await expect(page.getByText('1 sessions')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2: skip the judge (the fake judge is selected by the environment).
  await expect(page.getByRole('heading', { name: 'How should sessions be graded?' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();

  // Step 3: the folder is empty, so the wizard offers to create the repository.
  await expect(page.getByRole('heading', { name: 'Where do your skills live?' })).toBeVisible();
  await expect(page.getByLabel('Path to your skills repo')).toHaveValue('/repos/skills');
  await page.getByRole('button', { name: 'Create a new skills repo here' }).click();
  await expect(page.getByText('✓ Found rubrics/ in this repo.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 4: the import runs, then Sessions opens.
  await expect(page.getByRole('heading', { name: 'Importing your history' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();
  await expect(page.getByText('5 sessions collected')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select Fix the login form' })).toBeVisible();

  // The history import has finished: all 36 sessions are stored.
  await expect
    .poll(async () => (await get(page.request, '/v1/sessions?result=all&limit=100')).items.length)
    .toBe(36);
  await expect(page.getByRole('cell', { name: 'Codex', exact: true })).toBeVisible();

  // The planted secrets never reach the UI or the API.
  const secret = (await allSessions(page.request)).find((s) =>
    s.title.startsWith('Fix the failing build'),
  );
  expect(secret, 'the planted-secret session was imported').toBeDefined();
  const id = secret?.id ?? '';
  await page.goto(`/sessions/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Fix the failing build');
  await expect(page.getByRole('region', { name: 'Trace' })).toContainText('events');
  const html = await page.content();
  const events = JSON.stringify(await get(page.request, `/v1/sessions/${id}/events?limit=500`));
  for (const secret of PLANTED) {
    expect(html, `UI shows ${secret}`).not.toContain(secret);
    expect(events, `events API shows ${secret}`).not.toContain(secret);
  }
});
