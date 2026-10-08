import { test, expect, waitForOfflineReady } from './fixtures';
async function trustedVault(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    const wasmPath='/wasm/needware_wasm.js';const storePath='/vault-store.js';
    const wasm=await import(/* webpackIgnore: true */ wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import(/* webpackIgnore: true */ storePath);
    const account=crypto.randomUUID();const vault=new wasm.BrowserVault(account);const store=await openVaultStore();
    const bytes=vault.local_backup();try {await store.save(account,bytes,null);}finally {bytes.fill(0);vault.free();store.close();}
    return account;
  });
}
test('unselected encrypted vault does not claim saved applications are missing',async({page,offlineServer})=>{
  await page.goto(offlineServer.url);const account=await trustedVault(page);
  await page.goto(`${offlineServer.url}encrypted`);
  await expect(page.getByText('Your encrypted library has not been opened.',{exact:false})).toBeVisible();
  await expect(page.getByRole('link',{name:'Open your encrypted account',exact:true})).toHaveAttribute('href','/account');
  await expect(page.getByText('No encrypted applications saved yet.',{exact:true})).toHaveCount(0);
  await page.goto(`${offlineServer.url}encrypted#account=${account}`);
  await page.reload();
  await expect(page.getByText('Encrypted browser storage ready',{exact:true})).toBeVisible();
  await expect(page.getByText('No encrypted applications saved yet.',{exact:true})).toBeVisible();
});
test('encrypted worker and opaque application frame retain durable edits through tab conflict and actual offline cold reload',async({page,context,offlineServer})=>{
  await page.goto(offlineServer.url);const account=await trustedVault(page);
  const url=`${offlineServer.url}encrypted#account=${account}`;await page.goto(url);
  await expect(page.getByText('Encrypted browser storage ready',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Try encrypted habit tracker',exact:true}).click();
  await expect(page.getByRole('region',{name:'Application permissions'})).toBeVisible();
  await page.getByRole('button',{name:'Trust signer and save encrypted application',exact:true}).click();
  const frame=page.frameLocator('iframe');await frame.getByLabel('Habit name').fill('Private encrypted UI');
  await frame.getByRole('button',{name:'Add habit',exact:true}).click();await expect(frame.getByText('Private encrypted UI',{exact:true})).toBeVisible();
  await frame.getByRole('button',{name:'Complete',exact:true}).click();await expect(frame.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await expect(page.getByText('Encrypted browser storage · 2 pending changes',{exact:true})).toBeVisible();
  const other=await context.newPage();await other.goto(url);await other.getByRole('button',{name:'Open Habit tracker',exact:true}).click();
  const second=other.frameLocator('iframe');await second.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(second.getByRole('button',{name:'Complete',exact:true})).toBeVisible();
  await frame.getByRole('button',{name:'Undo',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'Document changed in another tab'})).toBeVisible();
  await expect(frame.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await other.close();await waitForOfflineReady(page);
  await offlineServer.stop();await page.reload();await page.getByRole('button',{name:'Open Habit tracker',exact:true}).click();
  await expect(frame.getByText('Private encrypted UI',{exact:true})).toBeVisible();await expect(frame.getByRole('button',{name:'Complete',exact:true})).toBeVisible();
  await frame.getByRole('button',{name:'Complete',exact:true}).click();await expect(frame.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await expect(page.getByText('Encrypted browser storage · 4 pending changes',{exact:true})).toBeVisible();
  expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
});
test('device-local application state is encrypted and restored without entering upload history',async({page,offlineServer})=>{
  await page.goto(offlineServer.url);const account=await trustedVault(page);
  const bytes=await page.evaluate(async()=>{const path='/wasm/needware_wasm.js';const wasm=await import(/* webpackIgnore: true */ path);return Array.from(wasm.authored_example()) as number[];});
  await page.goto(`${offlineServer.url}encrypted#account=${account}`);
  await expect(page.getByText('Encrypted browser storage ready',{exact:true})).toBeVisible();
  await page.getByLabel('Import encrypted-library application').setInputFiles({name:'local.need',mimeType:'application/vnd.needware.package',buffer:Buffer.from(bytes)});
  await page.getByRole('button',{name:'Trust signer and save encrypted application',exact:true}).click();
  const frame=page.frameLocator('iframe');await frame.getByLabel('Habit name').fill('Never enters shared history');
  await frame.getByRole('button',{name:'Add habit',exact:true}).click();await expect(frame.getByText('Never enters shared history',{exact:true})).toBeVisible();
  await expect(page.getByText('Encrypted browser storage · 0 pending changes',{exact:true})).toBeVisible();
  await waitForOfflineReady(page);await offlineServer.stop();await page.reload();
  await page.getByRole('button',{name:'Open Habit tracker',exact:true}).click();await expect(frame.getByText('Never enters shared history',{exact:true})).toBeVisible();
  await expect(page.getByText('Encrypted browser storage · 0 pending changes',{exact:true})).toBeVisible();
});
test('synchronized package review preserves its signed definition and directs installation to encrypted storage',async({page,offlineServer})=>{
  await page.goto(offlineServer.url);const account=await trustedVault(page);
  await page.goto(`${offlineServer.url}encrypted#account=${account}`);
  await page.getByRole('button',{name:'Try encrypted habit tracker',exact:true}).click();
  await page.getByRole('button',{name:'Trust signer and save encrypted application',exact:true}).click();
  const exported=page.waitForEvent('download');await page.getByRole('button',{name:'Export plaintext package',exact:true}).click();
  const path=await (await exported).path();expect(path).toBeTruthy();
  const {readFile}=await import('node:fs/promises');const bytes=await readFile(path!);
  await page.goto(offlineServer.url);await page.getByLabel('Import .need',{exact:true}).setInputFiles({name:'shared.need',mimeType:'application/vnd.needware.package',buffer:bytes});
  await expect(page.getByRole('region',{name:'Encrypted storage required'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Trust signer and run application',exact:true})).toBeDisabled();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download signed definition',exact:true}).click();
  expect(await readFile((await (await download).path())!)).toEqual(bytes);
  await page.getByRole('link',{name:'Open Your encrypted apps',exact:true}).click();
  await expect(page.getByText('Encrypted browser storage ready',{exact:true})).toBeVisible();
  await page.getByLabel('Import encrypted-library application').setInputFiles({name:'shared.need',mimeType:'application/vnd.needware.package',buffer:bytes});
  await expect(page.getByRole('region',{name:'Application permissions'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Trust signer and save encrypted application',exact:true})).toBeEnabled();
});
test('sharing approval is bound to the opened application, recipient and edit permission',async({page,offlineServer})=>{
  await page.goto(offlineServer.url);const account=await trustedVault(page);await page.goto(`${offlineServer.url}encrypted#account=${account}`);
  await expect(page.getByText('Encrypted browser storage ready',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Try encrypted habit tracker',exact:true}).click();await page.getByRole('button',{name:'Trust signer and save encrypted application',exact:true}).click();
  const identity=await page.evaluate(async()=>{const path='/wasm/needware_wasm.js';const wasm=await import(/* webpackIgnore: true */path);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});const v=new wasm.BrowserVault(crypto.randomUUID());try{return JSON.stringify({format:'needware-collaboration-device-v1',certificate:JSON.parse(v.device_certificate())});}finally{v.free();}});
  await page.getByText('Share this application',{exact:true}).click();
  const recipient=page.getByLabel('Recipient collaboration device');await recipient.setInputFiles({name:'recipient.json',mimeType:'application/json',buffer:Buffer.from(identity)});
  const consent=page.getByLabel('I verified this recipient device and approve sharing'),write=page.getByLabel('Allow this recipient to edit shared data'),share=page.getByRole('button',{name:'Approve recipient and download invitation',exact:true});
  await consent.check();await expect(share).toBeEnabled();await write.check();await expect(consent).not.toBeChecked();await expect(share).toBeDisabled();
  await consent.check();await recipient.setInputFiles({name:'recipient-again.json',mimeType:'application/json',buffer:Buffer.from(identity)});await expect(write).not.toBeChecked();await expect(consent).not.toBeChecked();
  await write.check();await consent.check();await expect(share).toBeEnabled();
  await page.getByRole('button',{name:'Try encrypted habit tracker',exact:true}).click();await page.getByRole('button',{name:'Trust signer and save encrypted application',exact:true}).click();
  await expect(page.getByRole('region',{name:'Encrypted library'}).getByRole('button',{name:'Open Habit tracker',exact:true})).toHaveCount(2);
  await expect(page.getByText('Recipient device:',{exact:false})).toHaveCount(0);await expect(write).not.toBeChecked();await expect(consent).not.toBeChecked();await expect(share).toBeDisabled();
});
