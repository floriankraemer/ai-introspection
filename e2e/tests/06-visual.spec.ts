import type { Page } from '@playwright/test';
import { expect, test, allSessions } from './support.ts';

// Visual regression: every screen in light and dark at 1280x860. Baselines live in
// e2e/__screenshots and are made in the Playwright container (`make e2e-update`), so the fonts match.
// Text that changes with the clock (relative times, dates, commit ids) is masked: the app has no way
// to fix "now", so those areas are covered with a box in the image.
for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    const shot = async (page: Page, name: string, mask: ReturnType<Page['locator']>[] = []) => {
      await expect(page.getByText('Loading', { exact: false })).toHaveCount(0);
      await expect(page).toHaveScreenshot(`${name}-${scheme}.png`, { fullPage: true, mask });
    };

    test('sessions', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('table', { name: 'Sessions' })).toBeVisible();
      await shot(page, 'sessions', [page.locator('tbody td:nth-child(5)')]);
    });

    test('session detail', async ({ page }) => {
      const s = (await allSessions(page.request)).find(
        (x) => x.title === 'Add the orders endpoint',
      );
      await page.goto(`/sessions/${s?.id ?? ''}`);
      await page.getByRole('button', { name: 'Show 3 evidence events' }).first().click();
      await expect(page.getByText(/^Highlighted: evidence for/)).toBeVisible();
      await shot(page, 'session-detail');
    });

    test('rubrics', async ({ page }) => {
      await page.goto('/rubrics');
      await expect(page.getByRole('complementary', { name: 'Calibration' })).toContainText('agree');
      await shot(page, 'rubrics');
    });

    test('proposals', async ({ page }) => {
      await page.goto('/proposals');
      await page.getByRole('tab', { name: /Accepted/ }).click();
      const detail = page.getByRole('region', { name: 'Proposal detail' });
      await expect(detail.getByText(/Merged as commit/)).toBeVisible();
      await shot(page, 'proposals', [
        page.getByText(/^Last run /),
        page.getByText(/^Next run /),
        detail.getByText(/drafted /),
        detail.getByText(/^Merged as commit/),
      ]);
    });

    test('trends', async ({ page }) => {
      await page.goto('/trends');
      await expect(
        page.getByRole('region', { name: 'Change log' }).getByRole('row'),
      ).not.toHaveCount(1);
      await shot(page, 'trends', [
        page.locator('svg.recharts-surface'),
        page.getByRole('region', { name: 'Change log' }).locator('tbody td:first-child'),
      ]);
    });

    test('settings', async ({ page }) => {
      await page.goto('/settings');
      await expect(page.getByText('2 need attention')).toBeVisible();
      await shot(page, 'settings', [
        page.getByRole('group', { name: 'Budget usage' }),
        page.getByText(/^Next run /),
      ]);
    });

    test('setup wizard, step 1', async ({ page }) => {
      await page.goto('/setup');
      await expect(page.getByText('35 sessions')).toBeVisible();
      await shot(page, 'wizard-sources');
    });
  });
}
