import { test } from './fixtures';
import { expect } from '@playwright/test';
test('concurrent WASM initialization keeps early vault handles bound to one instance', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/wasm/needware_wasm.js';
    const wasm = await import(/* webpackIgnore: true */ modulePath);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async (...args) => { fetches++; await gate; return realFetch(...args); };
    let vault: InstanceType<typeof wasm.BrowserVault> | undefined;
    try {
      const options = { module_or_path: '/wasm/needware_wasm_bg.wasm' };
      const first = wasm.default(options).then(() => { vault = new wasm.BrowserVault(crypto.randomUUID()); });
      const remaining = Array.from({ length: 16 }, () => wasm.default(options));
      let syncRejected = false;
      try { wasm.initSync(new Uint8Array()); } catch { syncRejected = true; }
      release(); await first; await Promise.all(remaining);
      const backup = vault!.local_backup(), restored = wasm.BrowserVault.from_local_backup(backup);
      backup.fill(0);
      const same = vault!.account_authority() === restored.account_authority();
      restored.free();
      return { fetches, syncRejected, same };
    } finally { release(); globalThis.fetch = realFetch; vault?.free(); }
  });
  expect(result).toEqual({ fetches: 1, syncRejected: true, same: true });
});
