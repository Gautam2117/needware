import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {verifyCloudEpochs} from './verify_cloud_epochs.mjs';
const require=createRequire(new URL('../apps/web/package.json',import.meta.url));
const {default:canonicalize}=await import(require.resolve('canonicalize'));
async function rateWindow(pool,account){
  const current=await pool.query('SELECT reset_at,count FROM needware_account_limit WHERE account_id=$1',[account]);
  if(current.rowCount&&current.rows[0].count>10){const remaining=Math.max(0,new Date(current.rows[0].reset_at).getTime()-Date.now()+100);
    if(remaining){console.log('Relay acceptance waiting for the existing account quota window');await new Promise(resolve=>setTimeout(resolve,Math.min(remaining,60_000)));}}
}
export async function verifyDocumentRelay({page,context,otherPage,otherContext,otherAccount,recoveredPage,enrolledPage,pool,account,origin}){
  if(process.env.NEEDWARE_TEST_EPOCH_FOCUS==='1'){
    // Diagnostic subset; CI and the full release check always retain the relay corpus below.
    for(const [client,name] of [[page,'__needwareRelay'],[otherPage,'__editableRelay']])await client.evaluate(async name=>{
      const wasm=await import('/wasm/needware_wasm.js');await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
      const {openVaultStore}=await import('/vault-store.js'),{DocumentRelay}=await import('/relay-client.js');
      const account=(await(await fetch('/api/auth/get-session')).json()).user.id,store=await openVaultStore(),root=await store.load(account),vault=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);
      globalThis[name]={wasm,store,vault,relay:new DocumentRelay(vault)};
    },name);
    await verifyCloudEpochs({page,otherPage,recoveredPage,enrolledPage,pool,account,otherAccount,origin});return;
  }
  await rateWindow(pool,account);
  execFileSync('cargo',['run','-p','xtask','--','relay-fixture'],{stdio:'inherit'});
  const packageBytes=(await readFile('artifacts/relay-transport-fixture.need')).toString('base64');
  let dropped=false;
  const loseResponse=async route=>{
    const body=route.request().postDataJSON();
    if(!dropped&&body.payload?.action==='chunk'&&body.payload.index===1){const actual=await route.fetch();assert.equal(actual.status(),200);dropped=true;await route.abort('failed');}
    else await route.continue();
  };
  await page.route(`${origin}/api/documents`,loseResponse);
  const metadata=await page.evaluate(async({account,packageBytes})=>{
    const wasmPath='/wasm/needware_wasm.js',storePath='/vault-store.js',journalPath='/sync-journal.js',relayPath='/relay-client.js';
    const wasm=await import(wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import(storePath),{DurableSyncSession}=await import(journalPath),{DocumentRelay}=await import(relayPath);
    const store=await openVaultStore();const root=await store.load(account);const vault=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);
    const bytes=Uint8Array.from(atob(packageBytes),char=>char.charCodeAt(0));const scope=JSON.stringify({values:[],collections:['habits']});const original=vault.start_document(bytes,crypto.randomUUID(),scope,1,true);
    const document=JSON.parse(original.binding()).document.document;const record=crypto.randomUUID();
    const journal=await DurableSyncSession.create(store.documents,vault,bytes,original,{account,rootGeneration:root.generation,scope,ownerEpoch:1,authority:vault.account_authority(),roster:JSON.stringify([JSON.parse(original.membership())])});
    await journal.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:record},name:{type:'string',value:'Actual private relay acceptance'}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));
    const frame=journal.pending()[0];const relay=new DocumentRelay(vault);let transportRejected=false;
    try{await relay.synchronize(journal);}catch{transportRejected=true;}
    const kept=journal.pending().length;const checkpoint=(await journal.prepareCloud()).uploadedChunks;
    await relay.synchronize(journal);
    globalThis.__needwareRelay={wasm,store,vault,journal,relay,document,record};
    return {document,record,pin:vault.account_authority(),frame,pending:journal.pending().length,snapshot:journal.snapshot(),transportRejected,kept,checkpoint};
  },{account,packageBytes});
  await page.unroute(`${origin}/api/documents`,loseResponse);
  assert(dropped);assert(metadata.transportRejected);assert.equal(metadata.kept,1);assert.equal(metadata.checkpoint,1);
  assert.equal(metadata.pending,0);
  const stored=await pool.query('SELECT descriptor,package_digest,storage_bytes FROM needware_document WHERE id=$1',[metadata.document]);assert.equal(stored.rowCount,1);
  const frameCount=await pool.query('SELECT count(*)::integer AS total FROM needware_document_frame WHERE document_id=$1',[metadata.document]);assert.equal(frameCount.rows[0].total,1);
  const chunks=await pool.query('SELECT ciphertext FROM needware_document_chunk WHERE document_id=$1',[metadata.document]);assert.equal(chunks.rowCount,4);
  assert(!chunks.rows[0].ciphertext.includes(Buffer.from('Actual private relay acceptance')));assert(!JSON.stringify(stored.rows[0]).includes('habits'));
  const duplicate=await page.evaluate(async frame=>{const r=globalThis.__needwareRelay;return r.relay.request({action:'upload',document:r.document,frame});},metadata.frame);
  assert.equal(typeof duplicate.digest,'string');assert.equal((await pool.query('SELECT count(*)::integer AS total FROM needware_document_frame WHERE document_id=$1',[metadata.document])).rows[0].total,1);
  // Proof is bound to exact payload, session and nonce. Reusing a consumed nonce cannot read again.
  const boundary=await page.evaluate(async()=>{
    const r=globalThis.__needwareRelay;const payload={action:'read',cursor:'0',document:r.document};
    const challenge=await(await fetch('/api/vault/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"operation":"relay_document"}'})).json();
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)));const hex=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
    const proof=JSON.parse(r.vault.account_operation(challenge.nonce,JSON.stringify('relay_document'),hex));
    const ordered={payload,proof};const canonical=v=>JSON.stringify(v,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
    const post=body=>fetch('/api/documents',{method:'POST',headers:{'Content-Type':'application/json'},body});
    const tamper=await post(canonical({payload:{...payload,cursor:'1'},proof}));
    const valid=await post(canonical(ordered));const replay=await post(canonical(ordered));
    const fake=new r.wasm.BrowserVault(JSON.parse(r.vault.account_context()).account);
    const fakeProof=JSON.parse(fake.account_operation(challenge.nonce,JSON.stringify('relay_document'),hex));fake.free();
    const unregistered=await post(canonical({payload,proof:fakeProof}));return {tamper:tamper.status,valid:valid.status,replay:replay.status,unregistered:unregistered.status};
  });assert.deepEqual(boundary,{tamper:403,valid:200,replay:403,unregistered:403});
  assert.equal((await context.request.post(`${origin}/api/documents`,{data:canonicalize({payload:{},proof:{}}),headers:{Origin:'https://attacker.example.invalid','Content-Type':'application/json'}})).status(),403);
  const denied=await otherPage.evaluate(async document=>{
    const wasmPath='/wasm/needware_wasm.js',storePath='/vault-store.js',relayPath='/relay-client.js';
    const wasm=await import(wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});const {openVaultStore}=await import(storePath),{DocumentRelay}=await import(relayPath);
    const account=(await(await fetch('/api/auth/get-session')).json()).user.id;const store=await openVaultStore();const root=await store.load(account);const vault=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);
    const relay=new DocumentRelay(vault);globalThis.__needwareRelay={wasm,store,vault,relay,document};
    let status;try{await relay.request({action:'read',document,cursor:'0'});}catch(error){status=error.status;}return {status,certificate:JSON.parse(vault.device_certificate()),context:vault.account_context(),pin:vault.account_authority()};
  },metadata.document);assert.equal(denied.status,403);
  // Owner explicitly grants the registered second device read-only access through signed HPKE.
  await page.evaluate(async target=>{
    const r=globalThis.__needwareRelay;const offer=JSON.parse(r.vault.offer_document(r.document,JSON.stringify(target.certificate),target.context,target.pin,false,true));
    await r.relay.request({action:'grant',document:r.document,recipient:target.certificate,membership:offer.membership,key_envelope:{kind:'offer',value:offer}});
  },denied);
  await rateWindow(pool,account);
  const imported=await otherPage.evaluate(async({account,pin})=>{
    const r=globalThis.__needwareRelay;const root=await r.store.load(account);root.bytes.fill(0);
    const journal=await r.relay.importDocument(r.store.documents,account,root.generation,r.document,pin,1,true);r.journal=journal;
    let readonly=false;try{await journal.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Forbidden'}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));}catch{readonly=true;}
    return {snapshot:journal.snapshot(),pending:journal.pending().length,readonly};
  },{account:otherAccount,pin:metadata.pin});assert.equal(imported.snapshot,metadata.snapshot);assert.equal(imported.pending,0);assert.equal(imported.readonly,true);
  const noWrite=await otherPage.evaluate(async frame=>{const r=globalThis.__needwareRelay;try{await r.relay.request({action:'upload',document:r.document,frame});return 200;}catch(error){return error.status;}},metadata.frame);assert.equal(noWrite,403);
  const badPin=await otherPage.evaluate(async account=>{const r=globalThis.__needwareRelay;const root=await r.store.load(account);root.bytes.fill(0);try{await r.relay.importDocument(r.store.documents,account,root.generation,r.document,'00'.repeat(32),1,true);return false;}catch{return true;}},otherAccount);assert.equal(badPin,true);
  // Inject only the owned fixture's remaining account capacity. Failed upload cannot consume its outbox or mutate server history.
  const usage=await pool.query('SELECT bytes FROM needware_relay_usage WHERE account_id=$1',[account]);
  await pool.query('UPDATE needware_relay_usage SET bytes=134217727 WHERE account_id=$1',[account]);
  try{
    const failed=await page.evaluate(async()=>{const r=globalThis.__needwareRelay;await r.journal.dispatch(JSON.stringify({action:'toggle',values:{record_id:{type:'string',value:r.record}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));
      let status;try{await r.relay.synchronize(r.journal);}catch(error){status=error.status;}return {status,pending:r.journal.pending().length};});
    assert.deepEqual(failed,{status:409,pending:1});assert.equal((await pool.query('SELECT count(*)::integer AS total FROM needware_document_frame WHERE document_id=$1',[metadata.document])).rows[0].total,1);
  }finally{await pool.query('UPDATE needware_relay_usage SET bytes=$2 WHERE account_id=$1',[account,usage.rows[0].bytes]);}
  await rateWindow(pool,account);
  const converged=await page.evaluate(async()=>{const r=globalThis.__needwareRelay;await r.relay.synchronize(r.journal);return {snapshot:r.journal.snapshot(),pending:r.journal.pending().length};});assert.equal(converged.pending,0);
  const received=await otherPage.evaluate(async()=>{const r=globalThis.__needwareRelay;await r.relay.synchronize(r.journal);return r.journal.snapshot();});assert.equal(received,converged.snapshot);
  const anonymous=await otherContext.browser().newContext();try{assert.equal((await anonymous.request.get(`${origin}/api/documents`)).status(),401);}finally{await anonymous.close();}
  // Reopen the actual encrypted application screen; its durable journal contains received cloud data.
  await otherPage.goto(`${origin}/encrypted#account=${otherAccount}`);await otherPage.getByRole('button',{name:'Open Habit tracker',exact:true}).click();
  const app=otherPage.frameLocator('iframe');await expect(app.getByText('Actual private relay acceptance',{exact:true})).toBeVisible();await expect(app.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await otherPage.goto(`${origin}/account`);
  // A newly recovered account device gets its own owner-signed grant, then reviews the signer before execution.
  await rateWindow(pool,account);
  await recoveredPage.goto(`${origin}/encrypted#account=${account}`);
  await expect(recoveredPage.getByText('Encrypted browser storage ready',{exact:true})).toBeVisible();
  await recoveredPage.getByRole('button',{name:'Find cloud applications',exact:true}).click();
  const card=recoveredPage.locator('article').filter({has:recoveredPage.getByText(`Encrypted application ${metadata.document.slice(0,8)}`,{exact:true})});
  await card.getByRole('button',{name:'Review cloud application',exact:true}).click();
  await expect(recoveredPage.getByRole('region',{name:'Cloud package review'})).toBeVisible();
  await expect(recoveredPage.locator('iframe')).toHaveCount(0);
  await recoveredPage.getByRole('button',{name:'Trust signer and import cloud application',exact:true}).click();
  const restored=recoveredPage.frameLocator('iframe');await expect(restored.getByText('Actual private relay acceptance',{exact:true})).toBeVisible();
  await expect(restored.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await restored.getByRole('button',{name:'Undo',exact:true}).click();await expect(restored.getByRole('button',{name:'Complete',exact:true})).toBeVisible();
  await recoveredPage.getByRole('button',{name:'Sync encrypted application',exact:true}).click();
  await expect(recoveredPage.getByText('Encrypted changes saved to cloud',{exact:true})).toBeVisible();
  await recoveredPage.screenshot({path:'artifacts/cloud-recovery-application.png',fullPage:true});
  await recoveredPage.goto(`${origin}/account`);
  // A distinct account receives an editable document, writes while offline, then converges.
  await rateWindow(pool,account);await rateWindow(pool,otherAccount);
  const writerTarget=await otherPage.evaluate(async()=>{
    const wasmPath='/wasm/needware_wasm.js',storePath='/vault-store.js';const wasm=await import(wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import(storePath);const account=(await(await fetch('/api/auth/get-session')).json()).user.id;
    const store=await openVaultStore();const root=await store.load(account);const vault=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);const certificate=JSON.parse(vault.device_certificate());vault.free();store.close();return certificate;
  });
  const editable=await page.evaluate(async target=>{
    const r=globalThis.__needwareRelay;const bytes=r.wasm.authored_sync_example();const scope=JSON.stringify({values:[],collections:['habits']});
    const original=r.vault.start_document(bytes,crypto.randomUUID(),scope,1,true);const document=JSON.parse(original.binding()).document.document;
    const root=await r.store.load(JSON.parse(r.vault.account_context()).account);root.bytes.fill(0);const path='/sync-journal.js';const {DurableSyncSession}=await import(path);
    const session=await DurableSyncSession.create(r.store.documents,r.vault,bytes,original,{account:JSON.parse(r.vault.account_context()).account,rootGeneration:root.generation,scope,ownerEpoch:1,authority:r.vault.account_authority(),roster:JSON.stringify([JSON.parse(original.membership())])});
    await r.relay.synchronize(session);const offer=JSON.parse(r.vault.offer_document(document,JSON.stringify(target),JSON.stringify(target.context),target.authority.map(v=>v.toString(16).padStart(2,'0')).join(''),true,true));
    await r.relay.request({action:'grant',document,recipient:target,membership:offer.membership,key_envelope:{kind:'offer',value:offer}});
    r.editable=session;return {document,pin:r.vault.account_authority()};
  },writerTarget);
  await otherPage.evaluate(async({account,document,pin})=>{
    const wasmPath='/wasm/needware_wasm.js',storePath='/vault-store.js',relayPath='/relay-client.js';const wasm=await import(wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import(storePath),{DocumentRelay}=await import(relayPath);const store=await openVaultStore();const root=await store.load(account);const vault=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);
    const relay=new DocumentRelay(vault);const session=await relay.importDocument(store.documents,account,root.generation,document,pin,1,true);globalThis.__editableRelay={store,vault,relay,session};
  },{account:otherAccount,...editable});
  await otherContext.setOffline(true);
  const offlineWrite=await otherPage.evaluate(async()=>{const r=globalThis.__editableRelay;await r.session.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Independent collaborator offline write'}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));return {state:r.session.snapshot(),pending:r.session.pending().length};});assert.equal(offlineWrite.pending,1);
  await otherContext.setOffline(false);await otherPage.evaluate(async()=>{const r=globalThis.__editableRelay;await r.relay.synchronize(r.session);});
  const ownerReceived=await page.evaluate(async()=>{const r=globalThis.__needwareRelay;await r.relay.synchronize(r.editable);return r.editable.snapshot();});assert.equal(ownerReceived,offlineWrite.state);
  await verifyCloudEpochs({page,otherPage,recoveredPage,enrolledPage,pool,account,otherAccount,origin});
  const ledgerBefore=await pool.query('SELECT bytes FROM needware_relay_usage WHERE account_id=$1',[account]);
  const cascadeSize=await pool.query('SELECT metadata_bytes FROM needware_document_member WHERE document_id=$1 AND account_id=$2',[editable.document,otherAccount]);
  assert.ok(cascadeSize.rows[0].metadata_bytes>0);
  // Delete only the acceptance member row to exercise the same AFTER DELETE
  // path used by account/device cascades, leaving both real accounts intact.
  await pool.query('DELETE FROM needware_document_member WHERE document_id=$1 AND account_id=$2',[editable.document,otherAccount]);
  const ledgerAfter=await pool.query('SELECT bytes FROM needware_relay_usage WHERE account_id=$1',[account]);
  assert.equal(Number(ledgerBefore.rows[0].bytes)-Number(ledgerAfter.rows[0].bytes),cascadeSize.rows[0].metadata_bytes);
  await page.evaluate(async()=>{const r=globalThis.__needwareRelay;await r.relay.request({action:'delete',document:JSON.parse(r.editable.binding()).document.document});await r.editable.close();});
  assert.equal((await pool.query('SELECT id FROM needware_document WHERE id=$1',[editable.document])).rowCount,0);
  assert.equal((await pool.query('SELECT document_id FROM needware_document_chunk WHERE document_id=$1',[editable.document])).rowCount,0);
  assert.equal((await pool.query('SELECT document_id FROM needware_document_frame WHERE document_id=$1',[editable.document])).rowCount,0);
  const total=await pool.query('SELECT COALESCE(sum(storage_bytes),0)::text AS bytes FROM needware_document WHERE owner_id=$1',[account]);
  const ledger=await pool.query('SELECT bytes FROM needware_relay_usage WHERE account_id=$1',[account]);
  assert.equal(ledger.rows[0].bytes,total.rows[0].bytes);
  const removed=await otherPage.evaluate(async document=>{const r=globalThis.__editableRelay;try{await r.relay.request({action:'read',document,cursor:'0'});return 200;}catch(error){return error.status;}},editable.document);assert.equal(removed,404);
  console.log('PASS real PostgreSQL encrypted package/chunk relay, independent verified-account offline writing/convergence, signed read/write grants, no-grant/read-only rejection, owner pin checks, nonce replay/payload tamper/CSRF, frame deduplication, atomic quota/outbox retention, owner deletion/cascades and WebKit owner recovery/package review/UI synchronization');
}
