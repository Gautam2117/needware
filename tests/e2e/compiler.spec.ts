import { test, expect } from '@playwright/test';
// This suite runs only through verify_compiler.mjs, which starts its labeled HTTP fixture.
test.skip(!process.env.NEEDWARE_FIXTURE_MODE, 'Requires the isolated compiler contract runner');
test('intent passes Rust compilation, permission review and WASM execution', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Local runtime ready', { exact: true })).toBeVisible();
  await page.getByLabel('Describe your application').fill('Track my reading habits');
  await expect(page.getByRole('button', { name: 'Create application', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /Fixture mode: authored contract-test output/ }).check();
  await page.getByRole('button', { name: 'Create application', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review Habit tracker' })).toBeVisible();
  await page.getByText('Creation checks', { exact: true }).click();
  await expect(page.locator('details').getByRole('listitem')).toHaveText([/Understanding your request/, /Building your application/, /Checking behavior and permissions/, /Ready for your review/]);
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: 'Trust signer and run application' }).click();
  const frame = page.frameLocator('iframe'); await frame.getByLabel('Habit name').fill('Read a chapter');
  await frame.getByRole('button', { name: 'Add habit', exact: true }).click();
  await expect(frame.getByText('Read a chapter', { exact: true })).toBeVisible();
});
test('cancelled compilation does not start an application', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Describe your application').fill('Track habits');
  await page.getByRole('checkbox', { name: /Fixture mode: authored contract-test output/ }).check();
  await page.getByRole('button', { name: 'Create application', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel creation', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Creation cancelled.' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
});
test('compiler proxy rejects a cross-origin mutation', async ({ request }) => {
  const response = await request.post('/api/compile-jobs', { data: { prompt: 'Track habits' }, headers: { origin: 'https://attacker.invalid' } });
  expect(response.status()).toBe(403);
});
