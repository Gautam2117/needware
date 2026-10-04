import { test, expect } from './fixtures';

test('foreign document keys survive encrypted local reload and holder recovery without inheriting old device grants', async ({ page, offlineServer }) => {
  await page.goto(offlineServer.url);
  const saved = await page.evaluate(async () => {
    const path = '/wasm/needware_wasm.js'; const storePath = '/vault-store.js';
    const wasm = await import(/* webpackIgnore: true */ path); const { openVaultStore } = await import(/* webpackIgnore: true */ storePath);
    await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
    const ownerAccount = crypto.randomUUID(); const holderAccount = crypto.randomUUID();
    const owner = new wasm.BrowserVault(ownerAccount); const holder = new wasm.BrowserVault(holderAccount);
    const pin = owner.account_authority(); const scope = JSON.stringify({ values: [], collections: ['habits'] });
    const bytes = wasm.authored_sync_example(); const original = owner.start_document(bytes, crypto.randomUUID(), scope, 1, true);
    const binding = JSON.parse(original.binding()); const document = binding.document.document;
    const offer = owner.offer_document(document, holder.device_certificate(), holder.account_context(), holder.account_authority(), true, true);
    const collaborator = holder.join_document(bytes, offer, JSON.stringify(binding.document), 1, pin, 1, scope, 1, true);
    const roster = JSON.stringify([JSON.parse(original.membership()), JSON.parse(collaborator.membership())]);
    original.set_roster(roster); collaborator.set_roster(roster);
    const record = crypto.randomUUID(); const event = (action: string, values: unknown) => JSON.stringify({ action, values, now: '2026-10-04T00:00:00Z', timezone: 'UTC' });
    original.dispatch(event('add', { record_id: { type: 'string', value: record }, name: { type: 'string', value: 'Private retained document' } }));
    const checkpoint = original.checkpoint(); collaborator.receive(checkpoint);
    const before = collaborator.snapshot(); const staged = collaborator.fork_session();
    staged.dispatch(event('toggle', { record_id: { type: 'string', value: record } }));
    const preserved = collaborator.snapshot() === before; const stagedCheckpoint = staged.checkpoint();
    const packageCipher = collaborator.seal_payload(bytes, 'private-package-v1');
    const recovery = JSON.parse(holder.create_recovery(true)); const holderContext = holder.account_context(); const holderPin = holder.account_authority();
    const held = holder.held_document_key_backup(document); const membership = collaborator.membership();
    const legacy = JSON.parse(new TextDecoder().decode(owner.local_backup()));
    legacy.version = 1; legacy.documents = [JSON.parse(owner.document_key_backup(document))]; delete legacy.held_documents;
    const legacyBytes = new TextEncoder().encode(JSON.stringify(legacy)); const legacyVault = wasm.BrowserVault.from_local_backup(legacyBytes); legacyBytes.fill(0);
    const legacySession = legacyVault.open_document(bytes, document, scope, 1, 1, true); legacySession.set_roster(roster); legacySession.receive(checkpoint);
    const legacyRestored = legacySession.snapshot() === before; legacySession.free(); legacyVault.free();
    const store = await openVaultStore();
    for (const [account, vault] of [[ownerAccount, owner], [holderAccount, holder]]) {
      const backup = vault.local_backup(); try { await store.save(account, backup, null); } finally { backup.fill(0); }
    }
    store.close(); for (const handle of [original, collaborator, staged, owner, holder]) handle.free();
    return { ownerAccount, holderAccount, pin, scope, document, documentContext: JSON.stringify(binding.document), roster,
      checkpoint, stagedCheckpoint, packageCipher: Array.from(packageCipher), held, membership, recovery, holderContext, holderPin, before, record, preserved, legacyRestored };
  });
  // Original handles/realm are gone; reopen only encrypted browser records with HTTP stopped.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await offlineServer.stop(); await page.reload();
  const result = await page.evaluate(async data => {
    const path = '/wasm/needware_wasm.js'; const storePath = '/vault-store.js';
    const wasm = await import(/* webpackIgnore: true */ path); const { openVaultStore } = await import(/* webpackIgnore: true */ storePath);
    await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' }); const store = await openVaultStore();
    const load = async (account: string) => { const backup = await store.load(account); if (!backup) throw new Error('Encrypted vault missing');
      try { return wasm.BrowserVault.from_local_backup(backup.bytes); } finally { backup.bytes.fill(0); } };
    const owner = await load(data.ownerAccount); const holder = await load(data.holderAccount);
    const bytes = wasm.authored_sync_example();
    const reopened = holder.open_shared_document(bytes, data.document, data.membership, 1, data.pin, 1, data.scope, 1, true);
    reopened.set_roster(data.roster); reopened.receive(data.checkpoint); const localRestored = reopened.snapshot() === data.before;
    const openedPackage = reopened.open_payload(new Uint8Array(data.packageCipher), 'private-package-v1');
    const packageRestored = JSON.parse(wasm.inspect_package(openedPackage)).application.id === JSON.parse(wasm.inspect_package(bytes)).application.id; openedPackage.fill(0);
    let metadataRejected = false; try { reopened.open_payload(new Uint8Array(data.packageCipher), 'another-purpose'); } catch { metadataRejected = true; }
    const recovered = new wasm.BrowserVault(undefined);
    recovered.recover(data.recovery.code, JSON.stringify(data.recovery.envelope), data.holderContext, data.holderPin);
    recovered.restore_held_document_key(data.held, data.documentContext);
    let oldGrantRejected = false;
    try { recovered.open_shared_document(bytes, data.document, data.membership, 1, data.pin, 1, data.scope, 1, true); } catch { oldGrantRejected = true; }
    // A new recovered device needs a new explicit owner grant; a recovery code grants no writer role.
    const renewed = JSON.parse(owner.offer_document(data.document, recovered.device_certificate(), recovered.account_context(), recovered.account_authority(), true, true));
    const next = recovered.open_shared_document(bytes, data.document, JSON.stringify(renewed.membership), 1, data.pin, 1, data.scope, 1, true);
    const roster = JSON.stringify([...JSON.parse(data.roster), renewed.membership]); next.set_roster(roster); next.receive(data.stagedCheckpoint);
    const record = JSON.parse(next.snapshot()).collections.habits[data.record];
    for (const handle of [reopened, next, recovered, owner, holder]) handle.free(); store.close();
    return { localRestored, packageRestored, metadataRejected, oldGrantRejected, recoveredEdit: record.done.value,
      ownerDistinct: data.ownerAccount !== data.holderAccount, preserved: data.preserved, legacyRestored: data.legacyRestored };
  }, saved);
  expect(result).toEqual({ localRestored: true, packageRestored: true, metadataRejected: true, oldGrantRejected: true,
    recoveredEdit: true, ownerDistinct: true, preserved: true, legacyRestored: true });
});
