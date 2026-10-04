import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { firefox, webkit, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { default: canonicalize } = await import(require.resolve('canonicalize'));
async function downloaded(page, button) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: button, exact: true }).click();
  const file = await event; return await readFile(await file.path());
}
const jsonFile = (name, buffer) => ({ name, mimeType: 'application/json', buffer });
export async function verifyAccountVault({ page, context, pool, account, origin, email, password }) {
  const clients = []; const contexts = []; const sent = [];
  page.on('request', request => { if (request.url() === `${origin}/api/vault` && request.method() === 'POST') sent.push(request.postData()); });
  try {
    await page.getByRole('button', { name: 'Set up encrypted account', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirm encrypted account setup', exact: true })).toBeDisabled();
    const file = await downloaded(page, 'Download recovery file'); const recovery = JSON.parse(file.toString());
    assert.equal(recovery.account, account); assert(recovery.code.startsWith('NW1-'));
    await page.getByLabel('Encryption device name').fill('Owner Chromium');
    await page.getByLabel('I saved my recovery file outside this browser').check();
    await page.getByRole('button', { name: 'Confirm encrypted account setup', exact: true }).click();
    await expect(page.getByText('Encryption keys are ready on this browser.', { exact: true })).toBeVisible();
    assert(sent.every(body => !body.includes(recovery.code)));
    const stored = await pool.query('SELECT context,authority,recovery FROM needware_account_vault WHERE account_id=$1', [account]);
    assert.equal(stored.rowCount, 1); assert.equal(stored.rows[0].recovery.ciphertext.length, 72);
    assert(!JSON.stringify(stored.rows[0]).includes(recovery.code));
    await page.reload(); await expect(page.getByText('Encryption keys are ready on this browser.', { exact: true })).toBeVisible();

    const browsers = [await firefox.launch(), await webkit.launch()]; clients.push(...browsers);
    const sessions = [];
    for (const browser of browsers) {
      const other = await browser.newContext(); const login = await other.request.post(`${origin}/api/auth/sign-in/email`, {
        data: { email, password }, headers: { Origin: origin },
      });
      contexts.push(other);
      assert.equal(login.status(), 200); const view = await other.newPage(); await view.goto(`${origin}/account`);
      await expect(view.getByText('This browser needs your recovery file or approval from a trusted device.', { exact: true })).toBeVisible();
      sessions.push({ view, other });
    }
    const enrolled = sessions[0];
    await enrolled.view.getByText('Use approval from another device', { exact: true }).click();
    const requestFile = await downloaded(enrolled.view, 'Download device request'); const requested = JSON.parse(requestFile.toString());
    // A reload must preserve the as-yet-unenrolled device key that owns this request.
    await enrolled.view.reload(); await enrolled.view.getByText('Use approval from another device', { exact: true }).click();
    await expect(enrolled.view.getByText(`Device identity: ${requested.device.id}`, { exact: false })).toBeVisible();
    await page.getByText('Approve another device', { exact: true }).click();
    await page.getByLabel('Open device request').setInputFiles(jsonFile('device-request.json', requestFile));
    await expect(page.getByRole('button', { name: 'Download encrypted approval', exact: true })).toBeDisabled();
    await page.getByLabel('I recognize this device and approve access to my encrypted account').check();
    const approvalFile = await downloaded(page, 'Download encrypted approval');
    assert(!approvalFile.includes(Buffer.from(recovery.code)));
    await enrolled.view.getByLabel('Encryption device name').fill('Enrolled Firefox');
    let enrollmentPost;
    enrolled.view.on('request', request => { if (request.url() === `${origin}/api/vault` && request.method() === 'POST') enrollmentPost = request.postData(); });
    await enrolled.view.getByLabel('Import encrypted device approval').setInputFiles(jsonFile('device-approval.json', approvalFile));
    await expect(enrolled.view.getByText('Encryption keys are ready on this browser.', { exact: true })).toBeVisible();
    assert(enrollmentPost); const replay = await enrolled.other.request.post(`${origin}/api/vault`, {
      data: enrollmentPost, headers: { Origin: origin, 'Content-Type': 'application/json' },
    }); assert.equal(replay.status(), 403);
    const altered = JSON.parse(enrollmentPost); altered.payload.label = 'Tampered label';
    const tamper = await enrolled.other.request.post(`${origin}/api/vault`, {
      data: canonicalize(altered), headers: { Origin: origin, 'Content-Type': 'application/json' },
    }); assert.equal(tamper.status(), 403);

    const recovered = sessions[1]; await recovered.view.getByLabel('Encryption device name').fill('Recovered WebKit');
    await recovered.view.getByLabel('Existing recovery code').fill('NW1-' + '00'.repeat(32) + '-00000000');
    await recovered.view.getByRole('button', { name: 'Recover with code', exact: true }).click();
    await expect(recovered.view.getByRole('region', { name: 'Encrypted account' }).getByRole('alert')).toBeVisible();
    await expect(recovered.view.getByText('This browser needs your recovery file or approval from a trusted device.', { exact: true })).toBeVisible();
    await recovered.view.getByLabel('Recover from saved file').setInputFiles(jsonFile('recovery.json', file));
    await expect(recovered.view.getByText('Encryption keys are ready on this browser.', { exact: true })).toBeVisible();
    await recovered.view.reload(); await expect(recovered.view.getByText('Encryption keys are ready on this browser.', { exact: true })).toBeVisible();
    assert.equal((await pool.query('SELECT device_id FROM needware_vault_device WHERE account_id=$1', [account])).rowCount, 3);

    // Possessing a login session and a newly generated root cannot replace the pinned root.
    const refused = await page.evaluate(async account => {
      const path = '/wasm/needware_wasm.js'; const wasm = await import(path); await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
      const fake = new wasm.BrowserVault(account); const payload = { label: 'Unapproved root' };
      const request = async (path, data) => fetch(`/api/vault${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data });
      const challenge = await (await request('/challenge', JSON.stringify({ operation: 'register_device' }))).json();
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
      const digest = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
      const proof = fake.account_operation(challenge.nonce, JSON.stringify('register_device'), digest); fake.free();
      // Rust emits canonical proof; label/payload have one key, and outer payload precedes proof.
      return (await request('', `{"payload":${JSON.stringify(payload)},"proof":${proof}}`)).status;
    }, account); assert.equal(refused, 403);
    assert.equal((await pool.query('SELECT device_id FROM needware_vault_device WHERE account_id=$1', [account])).rowCount, 3);
    const denied = await context.request.post(`${origin}/api/vault/challenge`, {
      data: canonicalize({ operation: 'register_device' }), headers: { Origin: 'https://attacker.example.invalid', 'Content-Type': 'application/json' },
    }); assert.equal(denied.status(), 403);
    const duplicate = await context.request.post(`${origin}/api/vault/challenge`, {
      data: '{"operation":"create_vault","operation":"register_device"}', headers: { Origin: origin, 'Content-Type': 'application/json' },
    }); assert.equal(duplicate.status(), 400);
    // A valid login must still be fresh before any device-changing challenge.
    const current = await (await context.request.get(`${origin}/api/auth/get-session`)).json();
    await pool.query('UPDATE auth_session SET "createdAt"=now()-interval \'1 hour\' WHERE id=$1 AND "userId"=$2', [current.session.id, account]);
    try {
      const stale = await context.request.post(`${origin}/api/vault/challenge`, { data: canonicalize({ operation: 'register_device' }),
        headers: { Origin: origin, 'Content-Type': 'application/json' } });
      assert.equal(stale.status(), 403);
    } finally { await pool.query('UPDATE auth_session SET "createdAt"=$1 WHERE id=$2 AND "userId"=$3', [current.session.createdAt, current.session.id, account]); }
    await page.reload(); await expect(page.getByText('Owner Chromium', { exact: true })).toBeVisible();
    await expect(page.getByText('Enrolled Firefox', { exact: true })).toBeVisible(); await expect(page.getByText('Recovered WebKit', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'artifacts/account-vault-acceptance.png', fullPage: true });
    await page.getByRole('link', { name: 'Open encrypted applications', exact: true }).click();
    await expect(page.getByText('Encrypted browser storage ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Try encrypted habit tracker', exact: true }).click();
    await page.getByRole('button', { name: 'Trust signer and save encrypted application', exact: true }).click();
    const app = page.frameLocator('iframe'); await app.getByLabel('Habit name').fill('Verified account encrypted application');
    await app.getByRole('button', { name: 'Add habit', exact: true }).click();
    await expect(app.getByText('Verified account encrypted application', { exact: true })).toBeVisible();
    await page.reload(); await page.getByRole('button', { name: 'Open Habit tracker', exact: true }).click();
    await expect(app.getByText('Verified account encrypted application', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'artifacts/encrypted-account-application.png', fullPage: true });
    await page.goto(`${origin}/account`); await expect(page.getByText('Owner Chromium', { exact: true })).toBeVisible();
    console.log('PASS real account-bound Chromium/Firefox/WebKit encrypted setup, retained device keys, HPKE enrollment, recovery after local key loss, signed one-use cloud challenges, replay/tamper/root pin/CSRF/duplicate-JSON boundaries');
  } finally {
    for (const other of contexts) await other.request.post(`${origin}/api/auth/sign-out`, { data: {}, headers: { Origin: origin } });
    for (const browser of clients) await browser.close();
  }
}
