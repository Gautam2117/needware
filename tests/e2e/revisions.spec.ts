import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Value } from '../../packages/ir-types/src/Value';
test('typed WASM inputs reject malformed events and empty-list state remains typed after reopen', async ({ page }) => {
  await page.goto('/');
  const bytes = [...readFileSync('artifacts/revisions/typed.need')];
  const result = await page.evaluate(async bytes => {
    const modulePath = '/wasm/needware_wasm.js';
    const wasm = await import(/* webpackIgnore: true */ modulePath);
    await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
    const packageBytes = new Uint8Array(bytes);
    const runtime = new wasm.BrowserRuntime(packageBytes, undefined, true);
    const before = runtime.snapshot(); let rejected = 0;
    for (const values of [{}, { numbers: { type: 'list', value: [{ type: 'boolean', value: true }] } }, { numbers: { type: 'list', value: [] }, extra: { type: 'null' } }]) {
      try { runtime.dispatch(JSON.stringify({ action: 'set_numbers', values, now: '2026-10-04T00:00:00Z', timezone: 'UTC' })); } catch { rejected++; }
      if (runtime.snapshot() !== before) throw new Error('Invalid input mutated state');
    }
    runtime.dispatch(JSON.stringify({ action: 'set_numbers', values: { numbers: { type: 'list', value: [{ type: 'integer', value: '42' }] } }, now: '2026-10-04T00:00:00Z', timezone: 'UTC' }));
    const saved = runtime.snapshot(); runtime.free();
    const reopened = new wasm.BrowserRuntime(packageBytes, saved, true);
    const invalid = JSON.parse(saved); invalid.values.numbers = { type: 'list', value: [{ type: 'string', value: '42' }] };
    let restoreRejected = false; try { reopened.restore(JSON.stringify(invalid)); } catch { restoreRejected = true; }
    const unchanged = reopened.snapshot() === saved; reopened.free();
    return { rejected, restoreRejected, unchanged, saved: JSON.parse(saved) };
  }, bytes);
  expect(result.rejected).toBe(3); expect(result.restoreRejected).toBe(true); expect(result.unchanged).toBe(true);
  expect(result.saved.values.numbers).toEqual({ type: 'list', value: [{ type: 'integer', value: '42' }] });
});
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
test('validated WASM state larger than IR reopens and invalid restore preserves state', async ({ page }) => {
  await page.goto('/');
  const bytes = [...readFileSync('artifacts/revisions/source.need')];
  const result = await page.evaluate(async bytes => {
    const modulePath = '/wasm/needware_wasm.js';
    const wasm = await import(/* webpackIgnore: true */ modulePath);
    await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
    const packageBytes = new Uint8Array(bytes);
    const info = JSON.parse(wasm.inspect_package(packageBytes));
    const records: Record<string, Record<string, Value>> = {};
    for (let i = 0; i < 10000; i++) records[`11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`] = { name: { type: 'string', value: 'x'.repeat(120) }, done: { type: 'boolean', value: false }, score: { type: 'integer', value: '0' } };
    const state = JSON.stringify({ revision: info.application.revision, values: {}, collections: { habits: records } });
    const first = new wasm.BrowserRuntime(packageBytes, state, true);
    const saved = first.snapshot(); first.free();
    const second = new wasm.BrowserRuntime(packageBytes, saved, true);
    let rejected = false;
    try { second.restore('{"revision":"a","revision":"b","values":{},"collections":{}}'); } catch { rejected = true; }
    const unchanged = second.snapshot() === saved;
    const count = Object.keys(JSON.parse(second.snapshot()).collections.habits).length; second.free();
    return { bytes: new TextEncoder().encode(saved).length, rejected, unchanged, count };
  }, bytes);
  expect(result.bytes).toBeGreaterThan(2 * 1024 * 1024);
  expect(result.count).toBe(10000); expect(result.rejected).toBe(true); expect(result.unchanged).toBe(true);
});
