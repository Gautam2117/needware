import { test, expect } from './fixtures';
test('verified Rust application persists, reloads and runs with server unavailable', async ({ page, offlineServer }) => {
  await page.goto(offlineServer.url);
  await expect(page.getByText('Local runtime ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Try the authored habit tracker' }).click();
  await expect(page.getByRole('heading', { name: 'Review Habit tracker' })).toBeVisible();
  await page.getByRole('button', { name: 'Trust signer and run application' }).click();
  const frame = page.frameLocator('iframe');
  await frame.getByLabel('Habit name').fill('Read offline');
  await frame.getByRole('button', { name: 'Add habit', exact: true }).click();
  await expect(frame.getByText('Read offline', { exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Open Habit tracker' }).click();
  await expect(frame.getByText('Read offline', { exact: true })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // Close the actual HTTP server: no asset or application request can succeed online.
  await offlineServer.stop();
  await page.reload();
  await page.getByRole('button', { name: 'Open Habit tracker' }).click();
  await expect(frame.getByText('Read offline', { exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Complete', exact: true })).toBeVisible();
  const sandbox = await page.locator('iframe').getAttribute('sandbox'); expect(sandbox).toBe('allow-scripts');
});
test('two tabs reject stale writes and recover database leadership', async ({ page, context }) => {
  await page.goto('/'); await expect(page.getByText('Local runtime ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Try the authored habit tracker' }).click();
  await page.getByRole('button', { name: 'Trust signer and run application' }).click();
  const other = await context.newPage(); await other.goto('/');
  await other.getByRole('button', { name: 'Open Habit tracker' }).click();
  const first = page.frameLocator('iframe'); const second = other.frameLocator('iframe');
  await first.getByLabel('Habit name').fill('Stale writer');
  await first.getByRole('button', { name: 'Add habit', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /another writer|Concurrent state change/ })).toBeVisible();
  await second.getByLabel('Habit name').fill('Keep this');
  await second.getByRole('button', { name: 'Add habit', exact: true }).click();
  await expect(second.getByText('Keep this', { exact: true })).toBeVisible();
  await page.close(); await other.reload();
  await other.getByRole('button', { name: 'Open Habit tracker' }).click();
  await expect(second.getByText('Keep this', { exact: true })).toBeVisible();
  await expect(second.getByText('Stale writer', { exact: true })).toHaveCount(0);
  await second.getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(second.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
});
test('malformed packages fail without opening an application', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('Local runtime ready', { exact: true })).toBeVisible();
  await page.getByLabel('Import .need').setInputFiles({ name: 'malicious.need', mimeType: 'application/vnd.needware.package', buffer: Buffer.from('NEEDPKG\0broken') });
  await expect(page.getByRole('alert').filter({ hasText: 'invalid package' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
});
test('reopening the same application replaces its bound channel', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('Local runtime ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Try the authored habit tracker' }).click();
  await page.getByRole('button', { name: 'Trust signer and run application' }).click();
  const frame = page.frameLocator('iframe'); await frame.getByLabel('Habit name').fill('Reconnect');
  await frame.getByRole('button', { name: 'Add habit', exact: true }).click();
  for (let index = 0; index < 3; index++) {
    const oldFrame = await page.locator('iframe').elementHandle();
    await page.getByRole('button', { name: 'Open Habit tracker' }).click();
    await expect.poll(() => oldFrame?.evaluate(element => element.isConnected)).toBe(false);
    await frame.getByRole('button', { name: index % 2 ? 'Undo' : 'Complete', exact: true }).click();
    await expect(frame.getByRole('button', { name: index % 2 ? 'Complete' : 'Undo', exact: true })).toBeVisible();
  }
});
