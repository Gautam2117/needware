import { test, expect } from './fixtures';

test('WASM devices enroll, recover, share and converge encrypted offline changes', async ({ page, offlineServer }) => {
  await page.goto(offlineServer.url);
  const result = await page.evaluate(async () => {
    const path = '/wasm/needware_wasm.js';
    const wasm = await import(/* webpackIgnore: true */ path);
    await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
    const owner = new wasm.BrowserVault(crypto.randomUUID());
    const second = new wasm.BrowserVault(undefined);
    const collaborator = new wasm.BrowserVault(crypto.randomUUID());
    const pin = owner.account_authority(); const context = owner.account_context();
    let rejectedApproval = false;
    try { owner.approve_device(second.device_public(), false); } catch { rejectedApproval = true; }
    const enrollment = owner.approve_device(second.device_public(), true);
    let rejectedPin = false;
    try { second.accept_enrollment(enrollment, context, '00'.repeat(32)); } catch { rejectedPin = true; }
    second.accept_enrollment(enrollment, context, pin);
    const recovery = JSON.parse(owner.create_recovery(true));
    const restored = new wasm.BrowserVault(undefined);
    let rejectedRecovery = false;
    try { restored.recover('NW1-' + '00'.repeat(32) + '-00000000', JSON.stringify(recovery.envelope), context, pin); } catch { rejectedRecovery = true; }
    restored.recover(recovery.code, JSON.stringify(recovery.envelope), context, pin);
    const recovered = restored.account_authority() === pin; restored.free();
    const bytes = wasm.authored_sync_example();
    const scope = JSON.stringify({ values: [], collections: ['habits'] });
    const a = owner.start_document(bytes, crypto.randomUUID(), scope, 1, true);
    const binding = JSON.parse(a.binding());
    const document = binding.document.document;
    const offer = (recipient: typeof second) => owner.offer_document(document, recipient.device_certificate(), recipient.account_context(), recipient.account_authority(), true, true);
    const b = second.join_document(bytes, offer(second), JSON.stringify(binding.document), 1, pin, 1, scope, 1, true);
    const c = collaborator.join_document(bytes, offer(collaborator), JSON.stringify(binding.document), 1, pin, 1, scope, 1, true);
    const roster = JSON.stringify([JSON.parse(a.membership()), JSON.parse(b.membership()), JSON.parse(c.membership())]);
    for (const client of [a, b, c]) client.set_roster(roster);
    // Keep only opaque Rust handles across the actual HTTP server shutdown.
    (window as unknown as { syncClients: unknown }).syncClients = { wasm, owner, second, collaborator, recovery, context, a, b, c, roster, bytes, scope, binding, pin };
    return { rejectedApproval, rejectedPin, rejectedRecovery, recovered, enrolled: second.account_authority() === pin };
  });
  expect(result).toEqual({ rejectedApproval: true, rejectedPin: true, rejectedRecovery: true, recovered: true, enrolled: true });
  await offlineServer.stop();
  const merged = await page.evaluate(() => {
    // Object stays in the trusted host realm; application frames never see vault handles.
    const clients = (window as unknown as { syncClients: Record<string, any> }).syncClients;
    const { a, b, c, owner, wasm, roster, bytes, scope, binding, pin, recovery, context } = clients;
    const record = '11111111-1111-4111-8111-111111111111';
    const event = (action: string, values: unknown) => JSON.stringify({ action, values, now: '2026-10-04T00:00:00Z', timezone: 'UTC' });
    const send = (from: typeof a, to: typeof b) => { for (const frame of JSON.parse(from.export(to.known()))) to.receive(JSON.stringify(frame)); };
    a.dispatch(event('add', { record_id: { type: 'string', value: record }, name: { type: 'string', value: 'Private walking habit' } }));
    send(a, b); send(a, c);
    a.dispatch(event('toggle', { record_id: { type: 'string', value: record } }));
    c.dispatch(event('add', { record_id: { type: 'string', value: '22222222-2222-4222-8222-222222222222' }, name: { type: 'string', value: 'Collaborator habit' } }));
    send(c, b); send(a, b); send(b, a); send(b, c);
    const checkpoint = a.checkpoint(); const state = a.snapshot();
    const keys = Object.keys(JSON.parse(checkpoint)).sort();
    let damagedRejected = false; const damaged = JSON.parse(checkpoint); damaged.ciphertext[25] ^= 1;
    try { b.receive(JSON.stringify(damaged)); } catch { damagedRejected = true; }
    const unchanged = b.snapshot() === state;
    const reader = new wasm.BrowserVault(crypto.randomUUID());
    const readOffer = owner.offer_document(binding.document.document, reader.device_certificate(), reader.account_context(), reader.account_authority(), false, true);
    const readClient = reader.join_document(bytes, readOffer, JSON.stringify(binding.document), 1, pin, 1, scope, 1, true);
    readClient.set_roster(roster); readClient.receive(checkpoint);
    let readRejected = false;
    try { readClient.dispatch(event('toggle', { record_id: { type: 'string', value: record } })); } catch { readRejected = true; }
    const backup = owner.document_key_backup(binding.document.document);
    const equal = a.snapshot() === b.snapshot() && a.snapshot() === c.snapshot(); const replay = b.receive(checkpoint);
    a.free(); b.free(); owner.free(); clients.second.free();
    // All owner vault/device handles are gone; only encrypted envelopes/history remain.
    const recoveredVault = new wasm.BrowserVault(undefined);
    recoveredVault.recover(recovery.code, JSON.stringify(recovery.envelope), context, pin);
    recoveredVault.restore_document_key(backup, JSON.stringify(binding.document));
    const recoveredClient = recoveredVault.open_document(bytes, binding.document.document, scope, 1, 1, true);
    recoveredClient.set_roster(roster); recoveredClient.receive(checkpoint);
    const result = { equal, count: Object.keys(JSON.parse(state).collections.habits).length,
      encrypted: !checkpoint.includes('Private walking habit'), keys, damagedRejected, unchanged, readRejected, recoveryRestored: recoveredClient.snapshot() === state, replay };
    for (const client of [recoveredClient, recoveredVault, readClient, reader, c, clients.collaborator]) client.free();
    return result;
  });
  expect(merged).toEqual({ equal: true, count: 2, encrypted: true, keys: ['binding', 'ciphertext'], damagedRejected: true, unchanged: true, readRejected: true, recoveryRestored: true, replay: 0 });
});
