import { expect, test, allSessions, get, gradeNow, send } from './support.ts';

// Flow 3: calibrate two rubrics, run the improver, edit, accept and reject proposals.
test('improve: trusted rubrics, proposals, invalid edit, accept, reject', async ({ page }) => {
  // Setup through the API: every session graded with the current rubrics.
  // Four failing sessions are held back for the second improver run: a session that a proposal
  // already covers is not proposed for again, so a new proposal needs new failing grades.
  const sessions = await allSessions(page.request);
  const held = sessions.filter((s) => s.toolErrors >= 3 && s.repo === 'gamma').slice(0, 4);
  expect(held).toHaveLength(4);
  const heldIds = new Set(held.map((s) => s.id));
  await gradeNow(
    page.request,
    sessions.filter((s) => !heldIds.has(s.id)).map((s) => s.id),
  );
  const graded = (await allSessions(page.request)).filter((s) => s.grades.length > 0);

  // Label sessions so that the judge agrees: 5 failing and 5 passing ones per rubric.
  const label = async (rubric: string, skipTitle: string | null) => {
    const verdict = (s: (typeof graded)[number]) =>
      s.grades.find((g) => g.rubric === rubric)?.passed === true;
    const pool = graded.filter((s) => s.title !== skipTitle);
    const picked = [
      ...pool.filter((s) => !verdict(s)).slice(0, 5),
      ...pool.filter(verdict).slice(0, 5),
    ];
    expect(picked).toHaveLength(10);
    for (const s of picked)
      await send(page.request, 'post', `/v1/rubrics/${rubric}/labels`, {
        sessionId: s.id,
        passed: verdict(s),
      });
  };
  await label('efficiency', 'Add the orders endpoint');

  // A second rubric gets one label in the UI and stays uncalibrated. Only one rubric is trusted:
  // the improver picks among equal clusters by a random repository id, and the screenshots need
  // the same proposal every run.
  const pool = graded.filter(
    (s) => s.grades.find((g) => g.rubric === 'redundant-tests')?.passed === true,
  );
  const [first] = pool;
  if (!first) throw new Error('unexpected seed');
  await page.goto('/rubrics');
  await page
    .getByRole('navigation', { name: 'Rubrics' })
    .getByRole('button', { name: /redundant-tests/ })
    .click();
  await page.getByRole('button', { name: 'Add label…' }).click();
  await page.getByLabel('Session to label').selectOption({ label: first.title });
  await page.getByRole('button', { name: 'Save label' }).click();
  await expect(page.getByRole('complementary', { name: 'Calibration' })).toContainText('1 / 10');
  await page.reload();
  const list = page.getByRole('navigation', { name: 'Rubrics' });
  await expect(list.getByRole('button', { name: /efficiency/ })).toContainText('trusted');
  await expect(list.getByRole('button', { name: /redundant-tests/ })).toContainText('1/1 agree');
  await expect(list.getByRole('button', { name: /redundant-tests/ })).toContainText('uncalibrated');
  await expect(list.getByRole('button', { name: /verbosity/ })).toContainText('uncalibrated');

  // Run the improver: one proposal per run and target.
  await page.getByRole('link', { name: 'Proposals' }).click();
  await expect(page.getByText('No rubric is trusted yet')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run improver now' }).click();
  await expect(page.getByText(/Last run .*succeeded, 1 proposal/)).toBeVisible();
  await expect(page.getByText(/Verbosity needs calibration/)).toBeVisible();
  const first1 = page.getByRole('button', { name: /Address efficiency failures/ });
  await expect(first1).toBeVisible();

  // An invalid edit is refused with a 422 and the reasons.
  const detail = page.getByRole('region', { name: 'Proposal detail' });
  await expect(detail.getByRole('heading', { name: /Address efficiency failures/ })).toBeVisible();
  await detail.getByRole('button', { name: 'Edit first' }).click();
  await detail.getByLabel('Diff (unified)').fill('this is not a unified diff');
  await detail.getByRole('button', { name: 'Save diff' }).click();
  await expect(detail.getByRole('alert')).toContainText('Diff refused');
  await detail.getByRole('button', { name: 'Cancel' }).click();

  // Reject it with a reason.
  await detail.getByRole('button', { name: 'Reject with reason…' }).click();
  await detail.getByLabel('Reason for rejecting').fill('Too generic for this repository');
  await detail.getByRole('button', { name: 'Reject proposal' }).click();
  await expect(detail.getByText('Rejected: Too generic for this repository')).toBeVisible();
  await page.getByRole('tab', { name: /Rejected/ }).click();
  await expect(page.getByRole('button', { name: /Address efficiency failures/ })).toBeVisible();

  // New failing grades: the next run drafts a second proposal. Accept it.
  await gradeNow(page.request, [...heldIds]);
  await page.getByRole('tab', { name: /Open/ }).click();
  await page.getByRole('button', { name: 'Run improver now' }).click();
  await expect(page.getByText(/Last run .*succeeded, 1 proposal/)).toBeVisible();
  await page.getByRole('button', { name: /Address .* failures/ }).click();
  await detail.getByRole('button', { name: 'Merge into main' }).click();
  await expect(detail.getByText(/Merged as commit/)).toBeVisible();
  const accepted = await get(page.request, '/v1/proposals?status=accepted');
  expect(accepted.items).toHaveLength(1);
  expect(accepted.items[0].mergeCommit).toBeTruthy();
});
