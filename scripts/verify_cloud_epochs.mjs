import assert from 'node:assert/strict';
import {expect} from '@playwright/test';
async function rateWindow(pool,account){
  const row=await pool.query('SELECT count,reset_at FROM needware_account_limit WHERE account_id=$1',[account]);
  if(row.rowCount&&row.rows[0].count>12){const wait=Math.max(0,new Date(row.rows[0].reset_at).getTime()-Date.now()+100);if(wait)await new Promise(resolve=>setTimeout(resolve,Math.min(wait,60_000)));}
}
export async function verifyCloudEpochs({page,otherPage,recoveredPage,enrolledPage,pool,account,otherAccount,origin}){
  console.log('Cloud epoch acceptance: independent writer and bounded large checkpoint');
  await rateWindow(pool,account);await rateWindow(pool,otherAccount);
  const target=await otherPage.evaluate(()=>JSON.parse(globalThis.__editableRelay.vault.device_certificate()));
  const initial=await page.evaluate(async target=>{
    const r=globalThis.__needwareRelay,{DurableSyncSession}=await import('/sync-journal.js');
    const bytes=r.wasm.authored_sync_example(),scope=JSON.stringify({values:[],collections:['habits']}),native=r.vault.start_document(bytes,crypto.randomUUID(),scope,1,true);
    for(let index=0;index<96;index++)native.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:`Cloud checkpoint record ${index}`}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));
    const root=await r.store.load(JSON.parse(r.vault.account_context()).account);root.bytes.fill(0);
    const journal=await DurableSyncSession.create(r.store.documents,r.vault,bytes,native,{account:JSON.parse(r.vault.account_context()).account,rootGeneration:root.generation,scope,ownerEpoch:1,authority:r.vault.account_authority(),roster:JSON.stringify([JSON.parse(native.membership())])});
    await r.relay.synchronize(journal);await r.relay.synchronize(journal);
    const document=JSON.parse(journal.binding()).document.document,offer=JSON.parse(r.vault.offer_document(document,JSON.stringify(target),JSON.stringify(target.context),target.authority.map(v=>v.toString(16).padStart(2,'0')).join(''),true,true));
    await r.relay.request({action:'grant',document,recipient:target,membership:offer.membership,key_envelope:{kind:'offer',value:offer}});
    r.epochJournal=journal;return {document,state:journal.snapshot(),pin:r.vault.account_authority()};
  },target);
  await otherPage.evaluate(async({document,pin,account})=>{const r=globalThis.__editableRelay,root=await r.store.load(account);root.bytes.fill(0);
    r.epoch=await r.relay.importDocument(r.store.documents,account,root.generation,document,pin,1,true);
    await r.epoch.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Stale offline work outside the cut'}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));
    r.oldEpochState=r.epoch.snapshot();
  },{...initial,account:otherAccount});
  const source=await pool.query('SELECT * FROM needware_document WHERE id=$1',[initial.document]);
  const oldFrames=await pool.query('SELECT frame FROM needware_document_frame WHERE document_id=$1 ORDER BY sequence',[initial.document]);
  const oldMembers=await pool.query('SELECT account_id,device_id,membership,key_envelope,metadata_bytes FROM needware_document_member WHERE document_id=$1 ORDER BY account_id,device_id',[initial.document]);
  const oldPackage=await pool.query('SELECT chunk_index,ciphertext FROM needware_document_chunk WHERE document_id=$1 ORDER BY chunk_index',[initial.document]);
  const staged=await page.evaluate(async()=>{const r=globalThis.__needwareRelay;
    const intent=await r.epochJournal.stageCloudEpoch(r.vault,true),next=JSON.parse(intent.next),cloud=next.cloud;
    r.epochPayload={action:'epoch_prepare',document:next.document,descriptor:cloud.descriptor,transition:intent.transition,checkpoint:intent.checkpoint,source_cursor:intent.sourceCursor,membership:cloud.membership,key_envelope:cloud.key_envelope};
    let blocked=false;try{await r.epochJournal.dispatch(JSON.stringify({action:'add',values:{},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));}catch{blocked=true;}
    return {blocked,bytes:intent.checkpoint.bytes,binding:r.epochJournal.binding()};
  });assert(staged.blocked);assert(staged.bytes>32768);assert.equal(JSON.parse(staged.binding).generation,1);
  for(const variant of ['signature','root','binding','generation']){
    const result=await page.evaluate(async variant=>{const r=globalThis.__needwareRelay,payload=structuredClone(r.epochPayload);
      if(variant==='signature')payload.transition.signature[0]^=1;
      if(variant==='root')payload.transition.root.epoch++;
      if(variant==='binding')payload.descriptor.binding.revision=crypto.randomUUID();
      if(variant==='generation')payload.descriptor.binding.generation++;
      try{await r.relay.request(payload);return 200;}catch(error){return error.status;}
    },variant);assert.equal(result,403);
  }
  assert.equal((await pool.query('SELECT document_id FROM needware_document_epoch WHERE document_id=$1',[initial.document])).rowCount,0);
  const wrongCursor=await page.evaluate(async()=>{const r=globalThis.__needwareRelay;try{await r.relay.request({...r.epochPayload,source_cursor:'0'});return 200;}catch(error){return error.status;}});assert.equal(wrongCursor,409);
  console.log('Cloud epoch acceptance: signed tamper and source cursor boundaries passed');
  await rateWindow(pool,account);
  const beforeQuota=await pool.query('SELECT bytes FROM needware_relay_usage WHERE account_id=$1',[account]);
  await pool.query('UPDATE needware_relay_usage SET bytes=134217728 WHERE account_id=$1',[account]);
  try{const quota=await page.evaluate(async()=>{const r=globalThis.__needwareRelay;try{await r.relay.request(r.epochPayload);return 200;}catch(error){return error.status;}});assert.equal(quota,409);
    assert.equal((await pool.query('SELECT document_id FROM needware_document_epoch WHERE document_id=$1',[initial.document])).rowCount,0);
  }finally{await pool.query('UPDATE needware_relay_usage SET bytes=$2 WHERE account_id=$1',[account,beforeQuota.rows[0].bytes]);}
  await page.evaluate(async()=>{const r=globalThis.__needwareRelay;await r.relay.request(r.epochPayload);});
  const charged=await pool.query('SELECT storage_bytes FROM needware_document WHERE id=$1',[initial.document]);
  await page.evaluate(async()=>{const r=globalThis.__needwareRelay;await r.relay.request(r.epochPayload);});
  assert.equal((await pool.query('SELECT storage_bytes FROM needware_document WHERE id=$1',[initial.document])).rows[0].storage_bytes,charged.rows[0].storage_bytes);
  const fixture=crypto.randomUUID().replaceAll('-',''),functionName=`epoch_fail_${fixture}`,triggerName=`epoch_fail_${fixture}`;
  await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${initial.document}' AND NEW.binding<>OLD.binding THEN RAISE EXCEPTION 'acceptance epoch activation refused'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON needware_document FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  try{
    const rejected=await page.evaluate(async()=>{const r=globalThis.__needwareRelay;try{await r.relay.resumeEpoch(r.epochJournal);return 200;}catch(error){return error.status;}});assert.equal(rejected,503);
    const unchanged=await pool.query('SELECT binding,next_sequence FROM needware_document WHERE id=$1',[initial.document]);assert.deepEqual(unchanged.rows[0],{binding:source.rows[0].binding,next_sequence:source.rows[0].next_sequence});
    assert.equal((await pool.query('SELECT status FROM needware_document_epoch WHERE document_id=$1',[initial.document])).rows[0].status,'staging');
    assert.equal((await pool.query('SELECT document_id FROM needware_document_member WHERE document_id=$1 AND account_id=$2',[initial.document,otherAccount])).rowCount,1);
    assert.deepEqual((await pool.query('SELECT frame FROM needware_document_frame WHERE document_id=$1 ORDER BY sequence',[initial.document])).rows,oldFrames.rows);
  }finally{await pool.query(`DROP TRIGGER ${triggerName} ON needware_document`);await pool.query(`DROP FUNCTION ${functionName}()`);}
  console.log('Cloud epoch acceptance: quota, duplicate staging and injected activation rollback passed');
  await rateWindow(pool,account);let dropped=false;
  const loseAck=async route=>{const body=route.request().postDataJSON();if(!dropped&&body.payload?.action==='epoch_activate'&&body.payload.document===initial.document){const response=await route.fetch();assert.equal(response.status(),200);dropped=true;await route.abort('failed');}else await route.continue();};
  await page.route(`${origin}/api/documents`,loseAck);
  const lost=await page.evaluate(async()=>{const r=globalThis.__needwareRelay;try{await r.relay.resumeEpoch(r.epochJournal);return false;}catch{return Boolean(r.epochJournal.cloudEpochIntent())&&JSON.parse(r.epochJournal.binding()).generation===1;}});
  await page.unroute(`${origin}/api/documents`,loseAck);assert(dropped);assert(lost);
  assert.equal((await pool.query('SELECT binding FROM needware_document WHERE id=$1',[initial.document])).rows[0].binding.generation,2);
  const restored=await page.evaluate(async()=>{const r=globalThis.__needwareRelay,{DurableSyncSession}=await import('/sync-journal.js');await r.epochJournal.close();
    const backup=r.vault.local_backup(),fresh=r.wasm.BrowserVault.from_local_backup(backup);backup.fill(0);
    r.epochJournal=await DurableSyncSession.open(r.store.documents,fresh,JSON.parse(fresh.account_context()).account,r.epochPayload.document,true);
    const {DocumentRelay}=await import('/relay-client.js');r.epochRelay=new DocumentRelay(fresh);await r.epochRelay.resumeEpoch(r.epochJournal);r.epochVault=fresh;
    await r.epochRelay.request({action:'epoch_activate',document:r.epochPayload.document,generation:2});
    return {state:r.epochJournal.snapshot(),generation:JSON.parse(r.epochJournal.binding()).generation,pending:Boolean(r.epochJournal.cloudEpochIntent())};
  });assert.deepEqual(restored,{state:initial.state,generation:2,pending:false});
  assert.deepEqual((await pool.query('SELECT frame FROM needware_document_epoch_frame WHERE document_id=$1 AND generation=1 ORDER BY sequence',[initial.document])).rows,oldFrames.rows);
  const archived=await pool.query('SELECT binding,descriptor,members,storage_bytes,source_cursor FROM needware_document_epoch WHERE document_id=$1 AND generation=1',[initial.document]);
  assert.deepEqual(archived.rows[0],{binding:source.rows[0].binding,descriptor:source.rows[0].descriptor,members:oldMembers.rows,storage_bytes:source.rows[0].storage_bytes,source_cursor:source.rows[0].next_sequence});
  assert.deepEqual((await pool.query('SELECT chunk_index,ciphertext FROM needware_document_epoch_chunk WHERE document_id=$1 AND generation=1 AND kind=\'package\' ORDER BY chunk_index',[initial.document])).rows,oldPackage.rows);
  const denied=await otherPage.evaluate(async document=>{const r=globalThis.__editableRelay,results=[];
    for(const payload of [{action:'read',document,cursor:'0'},{action:'download',document,index:0},{action:'upload',document,frame:r.epoch.pending()[0]}]){try{await r.relay.request(payload);results.push(200);}catch(error){results.push(error.status);}}
    return {results,pending:r.epoch.pending().length,preserved:r.epoch.snapshot()===r.oldEpochState};
  },initial.document);assert.deepEqual(denied,{results:[403,403,403],pending:1,preserved:true});
  const newCipher=await page.evaluate(async()=>{const r=globalThis.__needwareRelay;return (await r.epochJournal.prepareCloud()).ciphertext;});
  const oldKeyDenied=await otherPage.evaluate(({document,ciphertext})=>{const r=globalThis.__editableRelay;try{r.vault.open_document_payload(document,Uint8Array.from(atob(ciphertext),c=>c.charCodeAt(0)),`NEEDWARE-CLOUD-PACKAGE-v1:${document}`);return false;}catch{return true;}},{document:initial.document,ciphertext:newCipher});assert(oldKeyDenied);
  console.log('Cloud epoch acceptance: lost acknowledgment recovery, exact archive and old collaborator denial passed');
  // The owner keeps recovery; a different account device must get its own fresh grant.
  await rateWindow(pool,account);await recoveredPage.goto(`${origin}/account`);
  const recovery=await recoveredPage.evaluate(async({account,document,pin})=>{const wasm=await import('/wasm/needware_wasm.js');await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import('/vault-store.js'),{DocumentRelay}=await import('/relay-client.js');const store=await openVaultStore(),root=await store.load(account),vault=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);const relay=new DocumentRelay(vault);
    await relay.recoverOwnerGrant(document);const journal=await relay.importDocument(store.documents,account,root.generation,document,pin,1,true);const state=journal.snapshot();await journal.close();vault.free();store.close();return state;
  },{account,document:initial.document,pin:initial.pin});assert.equal(recovery,initial.state);
  for(const [client,generation] of [[recoveredPage,3],[enrolledPage,4]]){
    await rateWindow(pool,account);await client.goto(`${origin}/encrypted#account=${account}`);
    await expect(client.getByText('Encrypted browser storage ready',{exact:true})).toBeVisible();
    if(client===enrolledPage){
      await client.getByRole('button',{name:'Find cloud applications',exact:true}).click();
      const card=client.locator('article').filter({has:client.getByText(`Encrypted application ${initial.document.slice(0,8)}`,{exact:true})});
      await card.getByRole('button',{name:'Review cloud application',exact:true}).click();await expect(client.getByRole('region',{name:'Cloud package review'})).toBeVisible();
      await client.getByRole('button',{name:'Trust signer and import cloud application',exact:true}).click();
    }else await client.locator(`[data-document="${initial.document}"]`).getByRole('button',{name:'Open Habit tracker',exact:true}).click();
    await expect(client.frameLocator('iframe').getByText('Cloud checkpoint record 95',{exact:true})).toBeVisible();
    await client.getByText('Document keys and access',{exact:true}).click();
    client.once('dialog',dialog=>dialog.accept());await client.getByRole('button',{name:'Rotate document keys and remove collaborator grants',exact:true}).click();
    await expect(client.getByText('Fresh document keys activated. Existing collaborator grants were removed.',{exact:true})).toBeVisible();
    assert.equal((await pool.query('SELECT binding FROM needware_document WHERE id=$1',[initial.document])).rows[0].binding.generation,generation);
    await client.reload();await client.locator(`[data-document="${initial.document}"]`).getByRole('button',{name:'Open Habit tracker',exact:true}).click();
    await expect(client.frameLocator('iframe').getByText('Cloud checkpoint record 95',{exact:true})).toBeVisible();await client.goto(`${origin}/account`);
  }
  await rateWindow(pool,account);
  const staleOwner=await page.evaluate(async({account,document,pin})=>{const r=globalThis.__needwareRelay,before=r.epochJournal.snapshot(),held=JSON.parse(r.epochVault.held_document_key_backup(document)).document,artifact=await r.epochJournal.prepareCloud();
    await r.epochRelay.recoverOwnerGrant(document);
    const root=await r.store.load(account);root.bytes.fill(0);const proposal=await r.epochRelay.prepareImport(r.store.documents,account,root.generation,document,pin,1,true);
    let blocked=false;try{await proposal.commit();}catch{blocked=true;}finally{proposal.close();}
    const bytes=r.epochVault.open_document_payload(document,Uint8Array.from(atob(artifact.ciphertext),c=>c.charCodeAt(0)),`NEEDWARE-CLOUD-PACKAGE-v1:${document}`);bytes.fill(0);
    return {blocked,preserved:r.epochJournal.snapshot()===before&&JSON.stringify(JSON.parse(r.epochVault.held_document_key_backup(document)).document)===JSON.stringify(held),generation:JSON.parse(r.epochJournal.binding()).generation};
  },{account,document:initial.document,pin:initial.pin});assert.deepEqual(staleOwner,{blocked:true,preserved:true,generation:2});
  const ledger=await pool.query('SELECT bytes FROM needware_relay_usage WHERE account_id=$1',[account]);const total=await pool.query('SELECT sum(storage_bytes)::text AS bytes FROM needware_document WHERE owner_id=$1',[account]);assert.equal(ledger.rows[0].bytes,total.rows[0].bytes);
  await page.evaluate(async()=>{const r=globalThis.__needwareRelay;await r.epochRelay.request({action:'delete',document:r.epochPayload.document});await r.epochJournal.close();r.epochVault.free();});
  for(const table of ['needware_document_epoch','needware_document_epoch_chunk','needware_document_epoch_frame'])assert.equal((await pool.query(`SELECT document_id FROM ${table} WHERE document_id=$1`,[initial.document])).rowCount,0);
  console.log('PASS actual PostgreSQL native-signed large checkpoint, tamper/root/binding/generation rejection, immutable staging/quota ledger, injected atomic activation rollback, lost activation acknowledgment+cold intent recovery, exact original archives, independent collaborator crypto/cloud denial with retained offline edits and WebKit owner recovery');
}
