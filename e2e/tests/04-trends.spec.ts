import { expect, test } from './support.ts';

// Flow 4: the merged proposal and a manual commit in the skills repository (made by run.sh between
// the phases) show as markers on the chart and as rows in the change log.
test('trends: markers and change log', async ({ page }) => {
  await page.goto('/trends');
  await expect(page.getByRole('heading', { name: 'Trends', level: 1 })).toBeVisible();
  const chart = page.getByRole('region', { name: 'Pass rate chart' });
  await expect(chart).toBeVisible();

  // Markers on the chart.
  await expect(chart.getByRole('button', { name: /^Address .* failures, / })).toHaveCount(1);
  await expect(
    chart.getByRole('button', { name: /^Add an e2e-testing skill \(manual edit\), / }),
  ).toHaveCount(1);

  // Change log rows.
  const log = page.getByRole('region', { name: 'Change log' });
  const proposal = log.getByRole('row').filter({ hasText: /Address .* failures/ });
  await expect(proposal.getByRole('link', { name: 'Proposal' })).toBeVisible();
  const manual = log.getByRole('row').filter({ hasText: 'Add an e2e-testing skill (manual edit)' });
  await expect(manual.getByRole('cell', { name: 'Manual edit', exact: true })).toBeVisible();
  // Nothing was graded after either change yet, so no verdict is given.
  await expect(manual.getByText(/Too early/)).toBeVisible();
  const reset = log.getByRole('row').filter({ hasText: 'Rubric change' });
  await expect(reset.getByText('baseline reset')).toBeVisible();
});
