import { expect, test, allSessions, get, NOW } from './support.ts';

// Flow 2: grade sessions, read the grades, correct the judge, tune a rubric.
test('grading: grades, evidence, a wrong-judge label, rubric edit', async ({ page }) => {
  const sessions = await allSessions(page.request);
  // Sessions of the last week, so that they count in the "last 7 days" header.
  const week = NOW - 6 * 24 * 3_600_000;
  const generated = sessions.filter(
    (s) => ['alpha', 'beta', 'gamma'].includes(s.repo ?? '') && Date.parse(s.startedAt) > week,
  );
  const failA = generated.find((s) => s.toolErrors >= 3);
  const clean = generated.find((s) => s.toolErrors === 0);
  if (!failA || !clean || generated.length !== 3) throw new Error('unexpected seed');

  await page.goto('/');
  await expect(page.getByText('0 graded')).toBeVisible();
  for (const s of generated)
    await page.getByRole('checkbox', { name: `Select ${s.title}` }).check();
  await page.getByRole('button', { name: 'Grade selected (3)' }).click();
  await expect(page.getByText('Graded.')).toBeVisible();
  await expect(page.getByText('3 graded')).toBeVisible();

  // Graded sessions: the failing ones show four failed rubrics, the clean one four passes.
  await page.getByRole('combobox', { name: 'Result' }).selectOption('all');
  const row = (title: string) => page.getByRole('row').filter({ hasText: title });
  await expect(row(failA.title).getByText('Fail', { exact: true })).toHaveCount(4);
  await expect(row(clean.title).getByText('Pass', { exact: true })).toHaveCount(4);

  // Session detail: the grades, with the judge's reason.
  await row(failA.title).getByRole('link', { name: failA.title }).click();
  const grades = page.getByRole('complementary', { name: 'Grades' });
  await expect(grades.getByRole('heading', { name: /judge: fake-judge/ })).toBeVisible();
  const card = grades.locator(':scope > div').filter({
    has: page.getByText('Efficiency', { exact: true }),
  });
  await expect(card.getByText(/^0 · Fail$/)).toBeVisible();
  await expect(card.getByText(/Fake judge: \d+ failed events/)).toBeVisible();

  // Evidence: the events the judge cited are highlighted in the trace.
  await card.getByRole('button', { name: 'Show 3 evidence events' }).click();
  await expect(page.getByText('Highlighted: evidence for Efficiency')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Trace' }).getByText('Evidence:')).toHaveCount(3);

  // Rubrics before the label: nothing compared yet.
  await page.getByRole('link', { name: 'Rubrics' }).click();
  const efficiency = page
    .getByRole('navigation', { name: 'Rubrics' })
    .getByRole('button', { name: /efficiency/ });
  await expect(efficiency).toContainText('0/0 agree');

  // "Judge was wrong": the label moves the calibration count.
  await page.goBack();
  await expect(card.getByText(/^0 · Fail$/)).toBeVisible();
  await card.getByRole('button', { name: 'Judge was wrong…' }).click();
  await expect(card.getByRole('radio', { name: 'Pass' })).toBeChecked();
  await card.getByLabel('Note').fill('The retries were needed to find the flaky test.');
  await card.getByRole('button', { name: 'Save label' }).click();
  await expect(card.getByText('Label saved.')).toBeVisible();
  await card.getByRole('link', { name: 'calibration of Efficiency' }).click();
  await expect(efficiency).toContainText('0/1 agree');
  await expect(
    page
      .getByRole('complementary', { name: 'Calibration' })
      .getByRole('row', { name: new RegExp(failA.title) }),
  ).toBeVisible();

  // Edit a rubric threshold and save: a new version, one commit in the skills repository.
  await page
    .getByRole('navigation', { name: 'Rubrics' })
    .getByRole('button', { name: /verbosity/ })
    .click();
  const editor = page.getByRole('region', { name: 'Editor' });
  await editor.getByLabel('Pass threshold').fill('0.8');
  await editor.getByRole('button', { name: 'Save as v2 (commit)' }).click();
  await expect(editor.getByText('Saved as v2 and committed to your skills repo.')).toBeVisible();
  await expect(editor.getByText('History (2 versions)')).toBeVisible();
  const saved = await get(page.request, '/v1/rubrics/verbosity');
  expect(saved.version).toBe(2);
  expect(saved.passThreshold).toBe(0.8);
  expect(saved.versions[0].message).toBe('Update verbosity rubric');
});
