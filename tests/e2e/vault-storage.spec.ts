import { test, expect } from './fixtures';

test('local encrypted vault survives offline reload, rejects stale writers and detects ciphertext corruption', async ({ page, offlineServer }) => {
  await page.goto(offlineServer.url);
  const saved = await page.evaluate(async () => {
    const modulePath = '/wasm/needware_wasm.js'; const storagePath = '/vault-store.js';
    const wasm = await import(/* webpackIgnore: true */ modulePath);
    await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
    const { openVaultStore } = await import(/* webpackIgnore: true */ storagePath);
    const account = crypto.randomUUID(); const vault = new wasm.BrowserVault(account);
    const pin = vault.account_authority(); const publicDevice = vault.device_public();
    const store = await openVaultStore(); const other = await openVaultStore();
    const bytes = vault.local_backup();
    const generation = await store.save(account, bytes, null); bytes.fill(0);
    const loaded = await store.load(account);
    if (!loaded) throw new Error('Vault was not persisted');
    const raced = await Promise.allSettled([store.save(account, loaded.bytes, generation), other.save(account, loaded.bytes, generation)]);
    loaded.bytes.fill(0);
    const writes = raced.filter(value => value.status === 'fulfilled').length;
    let staleRejected = false;
    const newBackup = vault.local_backup();
    try { await other.save(account, newBackup, generation); } catch { staleRejected = true; }
    finally { newBackup.fill(0); }
    const opening = indexedDB.open('needware-vault-1', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    const request = db.transaction('vaults').objectStore('vaults').get(account);
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const key = record.key as CryptoKey; let nonExtractable = false;
    try { await crypto.subtle.exportKey('raw', key); } catch { nonExtractable = true; }
    const encryptedOnly = Object.keys(record).sort().join(',') === 'ciphertext,generation,id,key,nonce,version';
    vault.free(); store.close(); other.close(); db.close();
    return { account, pin, publicDevice, generation, writes, staleRejected, nonExtractable, encryptedOnly };
  });
  expect(saved).toMatchObject({ generation: 1, writes: 1, staleRejected: true, nonExtractable: true, encryptedOnly: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await offlineServer.stop();
  await page.reload();
  const reopened = await page.evaluate(async saved => {
    const modulePath = '/wasm/needware_wasm.js'; const storagePath = '/vault-store.js';
    const wasm = await import(/* webpackIgnore: true */ modulePath);
    await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
    const { openVaultStore } = await import(/* webpackIgnore: true */ storagePath);
    const store = await openVaultStore(); const loaded = await store.load(saved.account);
    if (!loaded) throw new Error('Vault missing after reload');
    const vault = wasm.BrowserVault.from_local_backup(loaded.bytes); loaded.bytes.fill(0);
    const authorityRestored = vault.account_authority() === saved.pin;
    const deviceRestored = vault.device_public() === saved.publicDevice;
    const opening = indexedDB.open('needware-vault-1', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    const tx = db.transaction('vaults', 'readwrite'); const objectStore = tx.objectStore('vaults'); const get = objectStore.get(saved.account);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      get.onsuccess = () => { const value = get.result; const bytes = new Uint8Array(value.ciphertext); bytes[0] ^= 1; objectStore.put({ ...value, ciphertext: bytes.buffer }); };
    });
    let corruptionRejected = false; try { await store.load(saved.account); } catch { corruptionRejected = true; }
    vault.free(); store.close(); db.close(); return { authorityRestored, deviceRestored, corruptionRejected, generation: loaded.generation };
  }, saved);
  expect(reopened).toEqual({ authorityRestored: true, deviceRestored: true, corruptionRejected: true, generation: 2 });
});
