import { test, expect } from '@playwright/test';
test('cross-root checkpoints retain history and recovery while excluding old root holders', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/wasm/needware_wasm.js', wasm = await import(/* webpackIgnore: true */ path);
    await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
    const source = new wasm.BrowserVault(crypto.randomUUID()), bytes = wasm.authored_sync_example();
    const scope = JSON.stringify({ values: [], collections: ['habits'] });
    const original = source.start_document(bytes, crypto.randomUUID(), scope, 1, true);
    original.dispatch(JSON.stringify({ action: 'add', values: { record_id: { type: 'string', value: crypto.randomUUID() }, name: { type: 'string', value: 'Retained across root rotation' } }, now: '2026-10-04T00:00:00Z', timezone: 'UTC' }));
    const before = original.binding(), document = JSON.parse(before).document.document;
    const oldRoot = source.account_context(), oldPin = source.account_authority(), oldRecovery = JSON.parse(source.create_recovery(true));
    let consentRejected = false; try { source.prepare_root_rotation(false); } catch { consentRejected = true; }
    const rotation = source.prepare_root_rotation(true), nextVault = rotation.preview();
    const historical = rotation.rewrap_held_backup(source.held_document_key_backup(document), JSON.stringify(JSON.parse(before).document));
    const epoch = nextVault.prepare_root_document_epoch(original, rotation.proof(), true);
    const device = new wasm.BrowserVault(undefined);
    device.accept_enrollment(nextVault.approve_device(device.device_public(), true), nextVault.account_context(), nextVault.account_authority());
    const offer = epoch.offer_document(nextVault, device.device_certificate(), device.account_context(), device.account_authority(), false, true);
    const checkpoint = epoch.checkpoint(), current = epoch.publish(nextVault), after = current.binding();
    const currentCipher = current.seal_payload(new Uint8Array([1, 2, 3]), 'new epoch');
    let oldKeyDenied = false; try { source.open_document_payload(document, currentCipher, 'new epoch'); } catch { oldKeyDenied = true; }
    const recipient = device.join_document(bytes, offer, JSON.stringify(JSON.parse(after).document), 2, nextVault.account_authority(), 2, scope, 1, true);
    recipient.set_roster(JSON.stringify([JSON.parse(current.membership()), JSON.parse(recipient.membership())]));
    let ordinaryRejected = false; try { recipient.install_epoch(checkpoint, before); } catch { ordinaryRejected = true; }
    recipient.install_root_epoch(checkpoint, before, oldRoot, oldPin);
    const retained = recipient.snapshot() === original.snapshot(), sourceIntact = source.account_context() === oldRoot;
    const recovery = JSON.parse(nextVault.create_recovery(true)), recovered = new wasm.BrowserVault(undefined);
    let oldRecoveryDenied = false; try { recovered.recover(oldRecovery.code, JSON.stringify(recovery.envelope), nextVault.account_context(), nextVault.account_authority()); } catch { oldRecoveryDenied = true; }
    recovered.recover(recovery.code, JSON.stringify(recovery.envelope), nextVault.account_context(), nextVault.account_authority());
    recovered.restore_held_document_key(nextVault.held_document_key_backup(document), JSON.stringify(JSON.parse(after).document));
    const newRecoveryWorks = Array.from(recovered.open_document_payload(document, currentCipher, 'new epoch')).join(',') === '1,2,3';
    const recoveredSession = recovered.open_shared_document(bytes, document, recovered.own_document_membership(document, 2), 2, nextVault.account_authority(), 2, scope, 1, true);
    recoveredSession.set_roster(JSON.stringify([JSON.parse(current.membership()), JSON.parse(recoveredSession.membership())]));
    recoveredSession.install_accepted_root_epoch(checkpoint, before);
    const recoveredHistoryAuthenticated = recoveredSession.snapshot() === original.snapshot();
    recoveredSession.free();
    const archiveVault = rotation.preview(); archiveVault.forget_document(document);
    archiveVault.restore_held_document_key(historical, JSON.stringify(JSON.parse(before).document));
    const archiveCipher = original.seal_payload(new Uint8Array([4, 5]), 'historical');
    const historyReadable = Array.from(archiveVault.open_document_payload(document, archiveCipher, 'historical')).join(',') === '4,5';
    const cutMatches = original.matches_root_epoch_cut(epoch.transition(), rotation.proof());
    archiveVault.free(); recovered.free(); recipient.free(); device.free(); current.free(); epoch.free(); nextVault.free(); rotation.free(); original.free(); source.free();
    return { consentRejected, oldKeyDenied, ordinaryRejected, retained, sourceIntact, oldRecoveryDenied, newRecoveryWorks, recoveredHistoryAuthenticated, historyReadable, cutMatches };
  });
  expect(Object.values(result)).toEqual(Array(10).fill(true));
});
