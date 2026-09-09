import { expect, test } from '@playwright/test';

/**
 * Smoke: a fresh browser profile must boot into onboarding with no
 * uncaught errors. This catches bundle breakage, React mount failures
 * and driver init regressions that unit tests cannot see.
 */
test('app boots and shows the onboarding welcome screen', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('/');

  await expect(page).toHaveTitle(/LifeMentor/);
  await expect(page.getByRole('button', { name: /Начать знакомство/ })).toBeVisible({ timeout: 20_000 });

  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
