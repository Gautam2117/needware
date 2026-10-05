import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {expect} from '@playwright/test';
export async function verifyRootUI({page,otherPage,recoveredPage,pool,account,origin,email,password,document,waitForWindow}){
  const signin=await page.context().request.post(`${origin}/api/auth/sign-in/email`,{data:{email,password},headers:{Origin:origin}});assert.equal(signin.status(),200);
  await page.goto(`${origin}/account`);await expect(page.getByText('Encryption keys are ready on this browser.',{exact:true})).toBeVisible();
  await page.getByText('Rotate account keys and remove devices',{exact:true}).click();
  await page.getByRole('button',{name:'Review account key rotation',exact:true}).click();
  await expect(page.getByRole('button',{name:'Rotate account keys',exact:true})).toBeDisabled();
  await page.getByRole('checkbox',{name:/Recovered WebKit/}).uncheck();
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download new recovery file',exact:true}).click();const file=await downloaded,recovery=JSON.parse((await readFile(await file.path())).toString());assert.equal(recovery.context.epoch,3);
  const sent=[];const capture=request=>{if(request.url()===`${origin}/api/vault/rotation`)sent.push(request.postData()??'');};page.on('request',capture);
  await page.getByLabel('I saved the new recovery file outside this browser',{exact:true}).check();
  await page.getByLabel('I approve fresh application keys, synchronization of current shared edits, and removal of unselected devices',{exact:true}).check();
  await page.getByRole('button',{name:'Rotate account keys',exact:true}).click();
  await expect(page.getByText("Account keys rotated. 1 shared application need their owner's fresh-key approval before shared writes resume.",{exact:true})).toBeVisible({timeout:90_000});page.off('request',capture);
  assert(sent.length>0&&sent.every(body=>!body.includes(recovery.code)));
  const root=await pool.query('SELECT context,recovery FROM needware_account_vault WHERE account_id=$1',[account]);assert.equal(root.rows[0].context.epoch,3);assert(!JSON.stringify(root.rows[0]).includes(recovery.code));
  assert.equal((await pool.query('SELECT device_id FROM needware_vault_device WHERE account_id=$1',[account])).rowCount,1);
  const pin=await page.evaluate(async()=>{const directory=await(await fetch('/api/vault')).json();return directory.vault.authority;});
  const encrypted=await page.evaluate(async({account,document})=>{const wasm=await import('/wasm/needware_wasm.js');await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});const {openVaultStore}=await import('/vault-store.js'),{DocumentRelay}=await import('/relay-client.js'),store=await openVaultStore(),saved=await store.load(account),vault=wasm.BrowserVault.from_local_backup(saved.bytes);saved.bytes.fill(0);try{return (await new DocumentRelay(vault).request({action:'download',document,index:0})).ciphertext;}finally{vault.free();store.close();}}, {account,document});
  const denied=await recoveredPage.evaluate(({document,encrypted})=>{const vault=globalThis.__retainedRoot.current,cipher=Uint8Array.from(atob(encrypted),char=>char.charCodeAt(0));try{vault.open_document_payload(document,cipher,`NEEDWARE-CLOUD-PACKAGE-v1:${document}`);return false;}catch{return true;}finally{cipher.fill(0);}}, {document,encrypted});assert(denied);
  const current=(await page.request.get(`${origin}/api/vault`));const directory=await current.json();
  await otherPage.evaluate(async certificate=>{const r=globalThis.__editableRelay;await r.relay.rotateEpoch(r.foreignRootJournal,true,[{certificate:JSON.stringify(certificate),context:JSON.stringify(certificate.context),authority:certificate.authority.map(byte=>byte.toString(16).padStart(2,'0')).join(''),write:true}]);},directory.vault.devices[0].certificate);
  assert.equal((await pool.query('SELECT document_id FROM needware_document_rekey WHERE account_id=$1',[account])).rowCount,0);
  await page.screenshot({path:'artifacts/account-root-device-rotation.png',fullPage:true});
  // Fresh recovery is a separate acceptance phase, with real limits inside it.
  await waitForWindow();
  const fresh=await page.context().browser().newContext();
  try{
    const login=await fresh.request.post(`${origin}/api/auth/sign-in/email`,{data:{email,password},headers:{Origin:origin}});assert.equal(login.status(),200);
    const client=await fresh.newPage();await client.goto(`${origin}/account`);await client.getByLabel('Encryption device name').fill('Fresh Root3 Recovery');
    await client.getByLabel('Recover from saved file').setInputFiles({name:'root3-recovery.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(recovery))});
    await expect(client.getByText('Encryption keys are ready on this browser.',{exact:true})).toBeVisible();
    await client.goto(`${origin}/encrypted#account=${account}`);await expect(client.getByText('Encrypted browser storage ready',{exact:true})).toBeVisible();
    await client.getByRole('button',{name:'Find cloud applications',exact:true}).click();const card=client.locator('article').filter({has:client.getByText(`Encrypted application ${document.slice(0,8)}`,{exact:true})});
    await card.getByRole('button',{name:'Review cloud application',exact:true}).click();try{await expect(client.getByRole('region',{name:'Cloud package review'})).toBeVisible({timeout:90_000});}catch(error){console.error('Fresh Root3 import diagnostic',await client.getByRole('alert').allTextContents());await client.screenshot({path:'artifacts/root3-import-failure.png',fullPage:true});throw error;}
    await client.getByRole('button',{name:'Trust signer and import cloud application',exact:true}).click();await expect(client.frameLocator('iframe').getByText('Root publication document 0',{exact:true})).toBeVisible();
    await client.reload();await client.locator(`[data-document="${document}"]`).getByRole('button',{name:'Open Habit tracker',exact:true}).click();await expect(client.frameLocator('iframe').getByText('Root publication document 0',{exact:true})).toBeVisible();
    await client.screenshot({path:'artifacts/root3-fresh-recovery-application.png',fullPage:true});
  }finally{await fresh.close();}
  assert.equal(pin,recovery.authority);console.log('PASS consumer named-device removal, saved new recovery confirmation, Root3 cloud/local history rotation, no recovery-code transmission, old Root2 cryptographic denial and fresh-browser Root3 recovery/import/cold reopen');
}
