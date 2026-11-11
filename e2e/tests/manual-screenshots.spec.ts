import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { allSessions, expect, get, gradeNow, scanNow, send, test } from './support.ts';

// The screenshots of the user manual (docs/manual). Run through `make manual-screenshots`; the normal
// E2E run skips this file (playwright.config.ts). It builds its own state on a fresh stack: the setup
// wizard, grading, calibration, one proposal, one manual edit. Every picture is one `shot` call.
//
// Adding a picture: add a `shot(page or locator, 'name')` call at the right point of the story,
// then reference docs/manual/images/name.png from the manual (see docs/manual/CONTRIBUTING.md).
const OUT = '/work/manual-images';
const BASE_URL = 'http://127.0.0.1:7317';
mkdirSync(OUT, { recursive: true });

async function shot(target: Page | Locator, name: string): Promise<void> {
  const page = 'page' in target ? target.page() : target;
  await expect(page.getByText('Loading', { exact: false })).toHaveCount(0);
  await target.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled', caret: 'hide' });
}

test('manual screenshots', async ({ page, browser }) => {
  test.setTimeout(300_000);

  await test.step('sign-in page (a browser without the cookie)', async () => {
    const ctx = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1280, height: 860 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
    });
    const anon = await ctx.newPage();
    await anon.goto('/');
    await expect(
      anon.getByRole('heading', { name: 'Open Introspect with its link' }),
    ).toBeVisible();
    await shot(anon, 'auth-required');
    await ctx.close();
  });

  await test.step('setup wizard', async () => {
    // Quiet the background sweep: only sessions with a merged pull request are graded on their own.
    await send(page.request, 'patch', '/v1/settings', { 'schedule.grade': 'pr_merge' });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Where are your sessions?' })).toBeVisible();
    await expect(page.getByText('35 sessions')).toBeVisible();
    await shot(page, 'wizard-step-1-sources');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(
      page.getByRole('heading', { name: 'How should sessions be graded?' }),
    ).toBeVisible();
    await shot(page, 'wizard-step-2-judge');
    await page.getByRole('radio', { name: /Local claude CLI/ }).check();
    await expect(page.getByRole('group', { name: 'Claude login' })).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Claude login' }).getByText('Checking…'),
    ).toHaveCount(0);
    await shot(page, 'wizard-step-2-judge-cli');
    await page.getByRole('button', { name: 'Skip' }).click();

    await expect(page.getByRole('heading', { name: 'Where do your skills live?' })).toBeVisible();
    await expect(page.getByLabel('Path to your skills repo')).toHaveValue('/repos/skills');
    await expect(page.getByRole('button', { name: 'Create a new skills repo here' })).toBeVisible();
    await shot(page, 'wizard-step-3-skills-repo');
    await page.getByRole('button', { name: 'Create a new skills repo here' }).click();
    await expect(page.getByText('✓ Found rubrics/ in this repo.')).toBeVisible();
    await shot(page, 'wizard-step-3-skills-repo-created');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Importing your history' })).toBeVisible();
    await shot(page, 'wizard-step-4-import');
    await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();
    await expect
      .poll(async () => (await get(page.request, '/v1/sessions?result=all&limit=100')).items.length)
      .toBe(36);
    // The scan remembers the skills repository tip; edits made after it count as changes.
    await scanNow(page.request);
  });

  const sessions = await allSessions(page.request);
  // Four failing sessions are held back from the first grading, so the improver finds work later.
  const held = sessions.filter((s) => s.toolErrors >= 3 && s.repo === 'gamma').slice(0, 4);
  const heldIds = new Set(held.map((s) => s.id));

  await test.step('sessions', async () => {
    const week = Date.parse(process.env.INTROSPECT_NOW ?? '') - 6 * 24 * 3_600_000;
    const recent = sessions.filter(
      (s) => ['alpha', 'beta', 'gamma'].includes(s.repo ?? '') && Date.parse(s.startedAt) > week,
    );
    await page.goto('/');
    await expect(page.getByRole('table', { name: 'Sessions' })).toBeVisible();
    for (const s of recent) await page.getByRole('checkbox', { name: `Select ${s.title}` }).check();
    await shot(page, 'sessions-select');
    await page.getByRole('button', { name: `Grade selected (${String(recent.length)})` }).click();
    await expect(page.getByText('Graded.')).toBeVisible();

    await gradeNow(
      page.request,
      sessions.filter((s) => !heldIds.has(s.id)).map((s) => s.id),
    );
    await page.goto('/');
    await expect(page.getByRole('table', { name: 'Sessions' })).toBeVisible();
    await shot(page, 'sessions-overview');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'sessions-overview-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await test.step('session detail', async () => {
    const s = sessions.find((x) => x.title === 'Add the orders endpoint');
    await page.goto(`/sessions/${s?.id ?? ''}`);
    await expect(page.getByRole('region', { name: 'Trace' })).toContainText('events');
    await shot(page, 'session-detail');
    await page.getByRole('button', { name: 'Show 3 evidence events' }).first().click();
    await expect(page.getByText(/^Highlighted: evidence for/)).toBeVisible();
    await shot(page, 'session-detail-evidence');
    const grades = page.getByRole('complementary', { name: 'Grades' });
    await shot(grades, 'session-grades');
    await page.getByRole('button', { name: 'Judge was wrong…' }).first().click();
    await shot(grades, 'session-judge-wrong');
    await page.getByRole('button', { name: 'Cancel' }).click();
    // Pin it: the reference set card on Trends shows it later.
    await page.getByRole('button', { name: 'Add to reference set' }).click();
    await expect(page.getByRole('button', { name: 'Remove from reference set' })).toBeVisible();
    for (const other of sessions.filter((x) => x.id !== s?.id && !heldIds.has(x.id)).slice(0, 4))
      await send(page.request, 'post', `/v1/sessions/${other.id}/reference`);
  });

  await test.step('rubrics', async () => {
    await page.goto('/rubrics');
    const list = page.getByRole('navigation', { name: 'Rubrics' });
    await list.getByRole('button', { name: /efficiency/ }).click();
    await expect(page.getByRole('region', { name: 'Editor' })).toBeVisible();
    await shot(page, 'rubrics-overview');
    await page.getByRole('button', { name: 'Add label…' }).click();
    await shot(page.getByRole('complementary', { name: 'Calibration' }), 'rubrics-add-label');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: /^Dry-run on/ }).click();
    await expect(page.getByRole('heading', { name: /^Dry-run results/ })).toBeVisible();
    await shot(page.getByRole('region', { name: 'Editor' }), 'rubrics-editor-dry-run');

    // Ten labels that agree with the judge: the rubric becomes trusted.
    const graded = (await allSessions(page.request)).filter((s) => s.grades.length > 0);
    const verdict = (s: (typeof graded)[number]) =>
      s.grades.find((g) => g.rubric === 'efficiency')?.passed === true;
    const pool = graded.filter((s) => s.title !== 'Add the orders endpoint');
    const picked = [
      ...pool.filter((s) => !verdict(s)).slice(0, 5),
      ...pool.filter(verdict).slice(0, 5),
    ];
    for (const s of picked)
      await send(page.request, 'post', '/v1/rubrics/efficiency/labels', {
        sessionId: s.id,
        passed: verdict(s),
      });
    await page.reload();
    await page
      .getByRole('navigation', { name: 'Rubrics' })
      .getByRole('button', { name: /efficiency/ })
      .click();
    await expect(page.getByRole('complementary', { name: 'Calibration' })).toContainText('Trusted');
    await shot(page.getByRole('complementary', { name: 'Calibration' }), 'rubrics-calibration');
    await shot(page, 'rubrics-calibrated');
  });

  await test.step('proposals', async () => {
    await page.goto('/proposals');
    await expect(page.getByText('The improver has not run yet')).toBeVisible();
    await shot(page, 'proposals-not-run');
    await page.getByRole('button', { name: 'Run improver now' }).click();
    await expect(page.getByText(/Last run .*succeeded, 1 proposal/)).toBeVisible();
    const detail = page.getByRole('region', { name: 'Proposal detail' });
    await expect(
      detail.getByRole('heading', { name: /Address efficiency failures/ }),
    ).toBeVisible();
    await expect(detail.getByText(/^Branch /)).toBeVisible();
    await shot(page, 'proposals-inbox');

    await detail.getByRole('button', { name: 'Edit first' }).click();
    await expect(detail.getByLabel('Diff (unified)')).toBeVisible();
    await shot(detail, 'proposal-edit');
    await detail.getByRole('button', { name: 'Cancel' }).click();

    await detail.getByRole('button', { name: 'Reject with reason…' }).click();
    await detail.getByLabel('Reason for rejecting').fill('Too generic for this repository');
    await shot(detail, 'proposal-reject');
    await detail.getByRole('button', { name: 'Cancel' }).click();

    await expect(detail.getByRole('button', { name: 'Merge into main' })).toBeVisible();
    await shot(detail, 'proposal-accept');
    await detail.getByRole('button', { name: 'Merge into main' }).click();
    await expect(detail.getByText(/Merged as commit/)).toBeVisible();
    await shot(detail, 'proposal-accepted');
  });

  await test.step('trends', async () => {
    // A person edits a skill outside Introspect, a second after the last thing the app did.
    const date = new Date((await scanNow(page.request)) + 1000).toISOString().slice(0, 19) + 'Z';
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', '/work/repos/skills', ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    mkdirSync('/work/repos/skills/skills/e2e-testing', { recursive: true });
    writeFileSync(
      '/work/repos/skills/skills/e2e-testing/SKILL.md',
      '# E2E testing\n\nRun the suite before you finish.\n',
    );
    git('add', 'skills');
    git('commit', '-q', '-m', 'Add an e2e-testing skill (manual edit)');
    await scanNow(page.request);

    await page.goto('/trends');
    const chart = page.getByRole('region', { name: 'Pass rate chart' });
    await expect(chart.getByRole('button', { name: /^Address .* failures, / })).toHaveCount(1);
    const log = page.getByRole('region', { name: 'Change log' });
    await expect(log.getByRole('row')).not.toHaveCount(1);
    await shot(page, 'trends-overview');
    await shot(chart, 'trends-chart');
    await shot(log, 'trends-change-log');
    await shot(page.getByRole('region', { name: 'Reference set' }), 'trends-reference-set');
  });

  await test.step('settings', async () => {
    // One person who pushes, so the People who push card shows a token.
    await send(page.request, 'post', '/v1/intake-tokens', { name: 'Ada', expiresInDays: 90 });
    await page.goto('/settings');
    const health = page.getByRole('region', { name: 'Health check' });
    await expect(health.getByText(/need attention|Everything works/)).toBeVisible();
    await shot(page, 'settings-overview');
    await shot(health, 'settings-health-check');
    for (const [name, file] of [
      ['Sources', 'settings-sources'],
      ['People who push', 'settings-people'],
      ['Redaction and retention', 'settings-redaction'],
      ['Judge', 'settings-judge'],
      ['Schedule', 'settings-schedule'],
      ['Skills repositories', 'settings-repos'],
      ['Trends', 'settings-trends'],
    ] as const)
      await shot(page.getByRole('region', { name, exact: true }), file);
  });
});
