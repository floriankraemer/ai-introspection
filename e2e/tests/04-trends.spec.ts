import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, scanNow } from './support.ts';

// Flow 4: the merged proposal and a manual commit in the skills repository show as markers on the
// chart and as rows in the change log.
test('trends: markers and change log', async ({ page }) => {
  // A person edits a skill in the skills repository, outside Introspect, a second after the last
  // thing the app did (its clock is NOW plus the real time since it started).
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
