import { test, expect } from './fixtures';

test('v1 vault upgrade and atomic runtime journals retain offline state, uploads and cursor across failed commits', async ({ page, offlineServer }) => {
  await page.goto(offlineServer.url);
  const saved = await page.evaluate(async () => {
    const wasmPath = '/wasm/needware_wasm.js'; const storePath = '/vault-store.js'; const journalPath = '/sync-journal.js';
    const wasm = await import(/* webpackIgnore: true */ wasmPath); await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
    const { openVaultStore } = await import(/* webpackIgnore: true */ storePath);
    const { DurableSyncSession } = await import(/* webpackIgnore: true */ journalPath);
    const account = crypto.randomUUID(); const vault = new wasm.BrowserVault(account); const pin = vault.account_authority();
    // Build the actual previous database format before opening the upgraded host.
    const opening = indexedDB.open('needware-vault-1', 1); opening.onupgradeneeded = () => opening.result.createObjectStore('vaults', { keyPath: 'id' });
    const db = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12)); const backup = vault.local_backup();
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(JSON.stringify({ domain: 'NEEDWARE-BROWSER-VAULT-v1', id: account, generation: 1 })) }, key, backup); backup.fill(0);
    const tx = db.transaction('vaults','readwrite'); tx.objectStore('vaults').put({ id: account, version: 1, generation: 1, key, nonce, ciphertext });
    await new Promise<void>((resolve,reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
    const store = await openVaultStore(); const root = await store.load(account); const upgraded = wasm.BrowserVault.from_local_backup(root.bytes); root.bytes.fill(0);
    const upgradePreserved = upgraded.account_authority() === pin; upgraded.free();
    const bytes = wasm.authored_sync_example(); const scope = JSON.stringify({ values: [], collections: ['habits'] });
    const original = vault.start_document(bytes,crypto.randomUUID(),scope,1,true); const document = JSON.parse(original.binding()).document.document;
    const roster = JSON.stringify([JSON.parse(original.membership())]);
    let wrongPackageRejected = false;
    try { await DurableSyncSession.create(store.documents,vault,wasm.authored_sync_example(),original,{ account, rootGeneration: 1, scope, ownerEpoch: 1, authority: pin, roster }); } catch { wrongPackageRejected = true; }
    if (!wrongPackageRejected || (await store.documents.list(account)).length) throw new Error('Mismatched package was persisted');
    const journal = await DurableSyncSession.create(store.documents,vault,bytes,original,{ account, rootGeneration: 1, scope, ownerEpoch: 1, authority: pin, roster });
    const record = crypto.randomUUID(); const event = (action: string, values: unknown) => JSON.stringify({ action, values, now: '2026-10-04T00:00:00Z', timezone: 'UTC' });
    await Promise.all([journal.dispatch(event('add',{ record_id: { type: 'string', value: record }, name: { type: 'string', value: 'Encrypted journal acceptance' } })),journal.dispatch(event('toggle',{ record_id: { type: 'string', value: record } }))]);
    const beforeAck = journal.pending().length; const first = journal.pending()[0]; await journal.acknowledge([first]);
    const pendingAfterAck = journal.pending().length;
    const stale = await DurableSyncSession.open(store.documents,vault,account,document,true); const staleState = stale.snapshot();
    await journal.dispatch(event('toggle',{ record_id: { type: 'string', value: record } }));
    let raceRejected = false; try { await stale.dispatch(event('toggle',{ record_id: { type: 'string', value: record } })); } catch { raceRejected = true; }
    const racePreserved = stale.snapshot() === staleState;
    const beforeBadBatch = journal.snapshot(); const oldCursor = journal.cursor();
    let invalidBatchRejected = false; try { await journal.receive([journal.pending()[0], '{}'],'uncommitted-cursor'); } catch { invalidBatchRejected = true; }
    const batchPreserved = journal.snapshot() === beforeBadBatch && journal.cursor() === oldCursor;
    await journal.receive([], 'durable-cursor');
    const rootBytes = vault.local_backup(); await store.save(account,rootBytes,1); rootBytes.fill(0);
    const beforeRootRace = journal.snapshot(); let rootRaceRejected = false;
    try { await journal.dispatch(event('toggle',{ record_id: { type: 'string', value: record } })); } catch { rootRaceRejected = true; }
    const rootRacePreserved = journal.snapshot() === beforeRootRace;
    const snapshot = journal.snapshot(); const pending = journal.pending().length;
    const inspect = indexedDB.open('needware-vault-1',2); const upgradedDb = await new Promise<IDBDatabase>(resolve => { inspect.onsuccess = () => resolve(inspect.result); });
    const read = upgradedDb.transaction('documents').objectStore('documents').get([account,document]);
    const stored = await new Promise<Record<string,unknown>>(resolve => { read.onsuccess = () => resolve(read.result); });
    const opaque = Object.keys(stored).sort().join(',') === 'account,ciphertext,document,generation,nonce,version' && !new TextDecoder().decode(stored.ciphertext as ArrayBuffer).includes('Encrypted journal acceptance');
    upgradedDb.close(); await journal.close(); await stale.close(); vault.free(); store.close();
    return { account,document,pin,snapshot,pending,upgradePreserved,beforeAck,pendingAfterAck,raceRejected,racePreserved,invalidBatchRejected,batchPreserved,rootRaceRejected,rootRacePreserved,opaque };
  });
  expect(saved).toMatchObject({ upgradePreserved: true, beforeAck: 2, pendingAfterAck: 1, raceRejected: true, racePreserved: true, invalidBatchRejected: true, batchPreserved: true, rootRaceRejected: true, rootRacePreserved: true, opaque: true, pending: 2 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null); await offlineServer.stop(); await page.reload();
  const reopened = await page.evaluate(async saved => {
    const wasmPath = '/wasm/needware_wasm.js'; const storePath = '/vault-store.js'; const journalPath = '/sync-journal.js';
    const wasm = await import(/* webpackIgnore: true */ wasmPath); await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
    const { openVaultStore } = await import(/* webpackIgnore: true */ storePath); const { DurableSyncSession } = await import(/* webpackIgnore: true */ journalPath);
    const store = await openVaultStore(); const root = await store.load(saved.account); const vault = wasm.BrowserVault.from_local_backup(root.bytes); root.bytes.fill(0);
    const session = await DurableSyncSession.open(store.documents,vault,saved.account,saved.document,true);
    const result = { snapshot: session.snapshot(), pending: session.pending().length, cursor: session.cursor(), pin: vault.account_authority(), documents: await store.documents.list(saved.account) };
    await session.close(); vault.free(); store.close(); return result;
  }, saved);
  expect(reopened).toEqual({ snapshot: saved.snapshot, pending: saved.pending, cursor: 'durable-cursor', pin: saved.pin, documents: [saved.document] });
});

test('document storage enforces count/size quotas, rejects concurrent replacements and authenticates namespace/ciphertext', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/vault-store.js'; const { openVaultStore } = await import(/* webpackIgnore: true */ path);
    const store = await openVaultStore(); const other = await openVaultStore(); const account = crypto.randomUUID();
    await store.save(account,new Uint8Array([1,2,3]),null); const document = crypto.randomUUID();
    await store.documents.save(account,document,new Uint8Array([4,5,6]),null,1);
    const writes = await Promise.allSettled([store.documents.save(account,document,new Uint8Array([7]),1,1),other.documents.save(account,document,new Uint8Array([8]),1,1)]);
    const raced = writes.filter(value => value.status === 'fulfilled').length;
    for (let index=1;index<256;index++) await store.documents.save(account,crypto.randomUUID(),new Uint8Array([index%255]),null,1);
    let countRejected=false;try { await store.documents.save(account,crypto.randomUUID(),new Uint8Array([1]),null,1); } catch { countRejected=true; }
    let sizeRejected=false;try { await store.documents.save(account,document,new Uint8Array(32*1024*1024+1),2,1); } catch { sizeRejected=true; }
    let wrongRootRejected=false;try { await store.documents.save(account,document,new Uint8Array([1]),2,2); } catch { wrongRootRejected=true; }
    await store.documents.remove(account,document,2,1); const countAfterRemoval=(await store.documents.list(account)).length;
    await store.documents.save(account,document,new Uint8Array([9]),null,1);
    const opening=indexedDB.open('needware-vault-1',2);const db=await new Promise<IDBDatabase>(resolve=>{ opening.onsuccess=()=>resolve(opening.result); });
    const tx=db.transaction('documents','readwrite');const objectStore=tx.objectStore('documents');const read=objectStore.get([account,document]);
    const copied=crypto.randomUUID();await new Promise<void>((resolve,reject)=>{ tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);read.onsuccess=()=>objectStore.put({...read.result,document:copied}); });
    let namespaceRejected=false;try { await store.documents.load(account,copied); } catch { namespaceRejected=true; }
    const corrupt=db.transaction('documents','readwrite');const records=corrupt.objectStore('documents');const get=records.get([account,document]);
    await new Promise<void>((resolve,reject)=>{ corrupt.oncomplete=()=>resolve();corrupt.onabort=()=>reject(corrupt.error);get.onsuccess=()=>{ const value=get.result;const bytes=new Uint8Array(value.ciphertext);bytes[0]^=1;records.put({...value,ciphertext:bytes.buffer}); }; });
    let corruptionRejected=false;try { await store.documents.load(account,document); } catch { corruptionRejected=true; }
    db.close();store.close();other.close();return {raced,countRejected,sizeRejected,wrongRootRejected,countAfterRemoval,namespaceRejected,corruptionRejected};
  });
  expect(result).toEqual({raced:1,countRejected:true,sizeRejected:true,wrongRootRejected:true,countAfterRemoval:255,namespaceRejected:true,corruptionRejected:true});
});

test('actual encrypted account byte quota commits at its boundary and frees capacity only after durable removal', async ({ page }) => {
  test.setTimeout(90_000); await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/vault-store.js'; const { openVaultStore } = await import(/* webpackIgnore: true */ path);
    const store = await openVaultStore(); const account = crypto.randomUUID();
    await store.save(account, new Uint8Array([1]), null);
    const bytes = new Uint8Array(32 * 1024 * 1024); const documents = [];
    for (let index = 0; index < 3; index++) { const document = crypto.randomUUID(); documents.push(document); await store.documents.save(account, document, bytes, null, 1); }
    const fourth = crypto.randomUUID(); let rejected = false;
    try { await store.documents.save(account, fourth, bytes, null, 1); } catch { rejected = true; }
    const rollbackCount = (await store.documents.list(account)).length;
    // Account accounting includes the 16-byte AEAD tag for each ciphertext.
    await store.documents.save(account, fourth, bytes.subarray(0, bytes.length - 64), null, 1);
    let fullRejected = false; try { await store.documents.save(account, crypto.randomUUID(), new Uint8Array([1]), null, 1); } catch { fullRejected = true; }
    await store.documents.remove(account, documents[0], 1, 1);
    await store.documents.save(account, crypto.randomUUID(), new Uint8Array([2]), null, 1);
    const finalCount = (await store.documents.list(account)).length; bytes.fill(0); store.close();
    return { rejected, rollbackCount, fullRejected, finalCount };
  });
  expect(result).toEqual({ rejected: true, rollbackCount: 3, fullRejected: true, finalCount: 4 });
});
