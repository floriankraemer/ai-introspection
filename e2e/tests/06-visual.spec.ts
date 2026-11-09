import type { Page } from '@playwright/test';
import { expect, test, allSessions } from './support.ts';

// Visual regression: every screen in light and dark at 1280x860. Baselines live in
// e2e/__screenshots and are made in the Playwright container (`make e2e-update`), so the fonts match.
// The app clock, the seed and the browser clock all start at INTROSPECT_NOW, so dates and relative
// times are stable and not masked. Only what varies from run to run (random ids) is masked.
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
      await shot(page, 'sessions');
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
      // Random per run: the branch suffix and the merge commit id.
      await shot(page, 'proposals', [
        detail.getByText(/^Branch /),
        detail.getByText(/^Merged as commit/),
      ]);
    });

    test('trends', async ({ page }) => {
      await page.goto('/trends');
      await expect(
        page.getByRole('region', { name: 'Change log' }).getByRole('row'),
      ).not.toHaveCount(1);
      await shot(page, 'trends');
    });

    test('settings', async ({ page }) => {
      await page.goto('/settings');
      await expect(page.getByText('3 need attention')).toBeVisible();
      await shot(page, 'settings');
    });

    test('setup wizard, step 1', async ({ page }) => {
      await page.goto('/setup');
      await expect(page.getByText('35 sessions')).toBeVisible();
      await shot(page, 'wizard-sources');
    });
  });
}
