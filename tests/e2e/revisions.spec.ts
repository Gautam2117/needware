import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
async function importPackage(page: Page, name: string, title: string) {
  await page.getByLabel('Import .need').setInputFiles(`artifacts/revisions/${name}.need`);
  await expect(page.getByRole('heading', { name: `Review ${title}`, exact: true })).toBeVisible();
}
async function source(page: Page, url = '/') {
  await page.goto(url); await expect(page.getByText('Local runtime ready', { exact: true })).toBeVisible();
  await importPackage(page, 'source', 'Habit tracker');
  await page.getByRole('button', { name: 'Trust signer and run application' }).click();
  const frame = page.frameLocator('iframe');
  await frame.getByLabel('Habit name').fill('Preserve through revision');
  await frame.getByRole('button', { name: 'Add habit', exact: true }).click();
  await expect(frame.getByText('Preserve through revision', { exact: true })).toBeVisible();
}
test('reviewed destructive revision persists, reopens offline and rolls back with recoverable history', async ({ page, offlineServer }) => {
  await source(page, offlineServer.url);
  await importPackage(page, 'target', 'Habit tracker revised');
  await page.getByRole('button', { name: 'Trust signer and review revision' }).click();
  await expect(page.getByRole('heading', { name: 'Review application revision' })).toBeVisible();
  const activate = page.getByRole('button', { name: 'Activate reviewed revision' }); await expect(activate).toBeDisabled();
  await page.getByLabel('I approve these destructive data changes').check(); await activate.click();
  await expect(page.getByRole('button', { name: 'Open Habit tracker revised' })).toBeVisible();
  await expect(page.frameLocator('iframe').getByText('Preserve through revision', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export plaintext data' }).click();
  const data = await (await download).createReadStream(); let text = ''; for await (const chunk of data!) text += chunk.toString();
  expect(text).toContain('Reviewed'); expect(text).not.toContain('"score"');
  await page.reload(); await page.getByRole('button', { name: 'Open Habit tracker revised' }).click();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await offlineServer.stop(); await page.reload();
  await page.getByRole('button', { name: 'Open Habit tracker revised' }).click();
  await page.getByRole('button', { name: 'Recovery history', exact: true }).click();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Restore generation 2' }).click();
  await expect(page.getByRole('button', { name: 'Open Habit tracker', exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe').getByText('Preserve through revision', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recovery history', exact: true }).click();
  const recovered = page.getByRole('region', { name: 'Recovery history' }).locator('article').filter({ hasText: 'Habit tracker revised' });
  await expect(recovered).toHaveCount(1);
  await expect(recovered.getByRole('button', { name: /Restore generation/ })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await recovered.getByRole('button', { name: /Restore generation/ }).click();
  await expect(page.getByRole('button', { name: 'Open Habit tracker revised' })).toBeVisible();
});
test('stale revision review and wrong parent preserve the durable application', async ({ page, context }) => {
  await source(page);
  await importPackage(page, 'wrong-parent', 'Habit tracker revised');
  await page.getByRole('button', { name: 'Trust signer and review revision' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'parent does not match' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Habit tracker', exact: true })).toBeVisible();
  await importPackage(page, 'target', 'Habit tracker revised');
  await page.getByRole('button', { name: 'Trust signer and review revision' }).click();
  const other = await context.newPage(); await other.goto('/'); await other.getByRole('button', { name: 'Open Habit tracker', exact: true }).click();
  await other.frameLocator('iframe').getByLabel('Habit name').fill('Concurrent record');
  await other.frameLocator('iframe').getByRole('button', { name: 'Add habit', exact: true }).click();
  await expect(other.frameLocator('iframe').getByText('Concurrent record', { exact: true })).toBeVisible();
  await page.getByLabel('I approve these destructive data changes').check(); await page.getByRole('button', { name: 'Activate reviewed revision' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'review is stale' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel revision' }).click();
  await page.getByRole('button', { name: 'Open Habit tracker', exact: true }).click();
  await expect(page.frameLocator('iframe').getByText('Concurrent record', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recovery history', exact: true }).click();
  await expect(page.getByText('No revision recovery copies yet.')).toBeVisible();
});
