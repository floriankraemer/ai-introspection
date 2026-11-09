import { expect, test } from './support.ts';

// Flow 5: the health check and settings that save on their own.
test('settings: health check and autosave', async ({ page }) => {
  await page.goto('/settings');
  const health = page.getByRole('region', { name: 'Health check' });
  await expect(health.getByText('2 need attention')).toBeVisible();
  await expect(
    health.getByRole('listitem').filter({ hasText: 'GitHub CLI (PR mode)' }).getByText('Warning'),
  ).toBeVisible();
  await expect(
    health.getByRole('listitem').filter({ hasText: 'Judge (fake)' }).getByText('Warning'),
  ).toBeVisible();
  await expect(
    health.getByRole('listitem').filter({ hasText: 'Global skills repository' }).getByText('OK'),
  ).toBeVisible();

  // A checkbox saves at once and survives a reload.
  const redact = page.getByRole('checkbox', { name: /Redact secrets at ingest/ });
  await expect(redact).toBeChecked();
  await redact.click();
  await expect(page.getByText('All changes saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: /Redact secrets at ingest/ })).not.toBeChecked();

  // A number saves when you leave the field.
  const days = page.getByLabel('Keep event payloads for (days)');
  await days.fill('120');
  await days.blur();
  await expect(page.getByText('All changes saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Keep event payloads for (days)')).toHaveValue('120');

  // Put both back: the next spec takes screenshots of the default state.
  await page.getByRole('checkbox', { name: /Redact secrets at ingest/ }).click();
  await expect(page.getByText('All changes saved.')).toBeVisible();
  await page.getByLabel('Keep event payloads for (days)').fill('90');
  await page.getByLabel('Keep event payloads for (days)').blur();
  await expect(page.getByText('All changes saved.')).toBeVisible();
});
