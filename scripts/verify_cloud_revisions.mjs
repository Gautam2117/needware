import assert from 'node:assert/strict';
import {expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {advanceAcceptanceWindow} from './acceptance-clock.mjs';
export async function verifyCloudRevisions({page,otherPage,pool,account,otherAccount,origin}){
  execFileSync('cargo',['run','-p','xtask','--','revision-fixture'],{stdio:'inherit'});
  const source=Array.from(await readFile('artifacts/revisions/sync-source.need')),target=Array.from(await readFile('artifacts/revisions/sync-target.need'));
  const window=async()=>{await advanceAcceptanceWindow(pool,{account});await advanceAcceptanceWindow(pool,{account:otherAccount});};
  await window();
  const recipient=await otherPage.evaluate(()=>JSON.parse(globalThis.__editableRelay.vault.device_certificate()));
  const initial=await page.evaluate(async({source,recipient})=>{
    const r=globalThis.__needwareRelay,{DurableSyncSession}=await import('/sync-journal.js');r.scope=JSON.stringify({values:[],collections:['habits']});
    const bytes=new Uint8Array(source),native=r.vault.start_document(bytes,crypto.randomUUID(),r.scope,1,true),root=await r.store.load(JSON.parse(r.vault.account_context()).account);root.bytes.fill(0);
    r.revision=await DurableSyncSession.create(r.store.documents,r.vault,bytes,native,{account:JSON.parse(r.vault.account_context()).account,rootGeneration:root.generation,scope:r.scope,ownerEpoch:1,authority:r.vault.account_authority(),roster:JSON.stringify([JSON.parse(native.membership())])});
    await r.revision.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Shared source'}},now:'2026-10-05T00:00:00Z',timezone:'UTC'}));
    await r.relay.synchronize(r.revision);await r.relay.synchronize(r.revision);
    const document=JSON.parse(r.revision.binding()).document.document,offer=JSON.parse(r.vault.offer_document(document,JSON.stringify(recipient),JSON.stringify(recipient.context),recipient.authority.map(v=>v.toString(16).padStart(2,'0')).join(''),true,true));
    await r.relay.request({action:'grant',document,recipient,membership:offer.membership,key_envelope:{kind:'offer',value:offer}});await r.relay.synchronize(r.revision);
    return {document,pin:r.vault.account_authority(),binding:r.revision.binding(),state:r.revision.snapshot()};
  },{source,recipient});
  await window();
  await otherPage.evaluate(async({document,pin,account})=>{const r=globalThis.__editableRelay,root=await r.store.load(account);root.bytes.fill(0);
    r.revision=await r.relay.importDocument(r.store.documents,account,root.generation,document,pin,1,true);
    await r.revision.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Offline edit before migration'}},now:'2026-10-05T00:00:00Z',timezone:'UTC'}));
  },{...initial,account:otherAccount});
  const staged=await page.evaluate(async({target,recipient})=>{const r=globalThis.__needwareRelay,bytes=new Uint8Array(target),review=await r.revision.reviewRevision(bytes,r.scope),digest=JSON.parse(review.info()).review_digest;
    const recipientPin=recipient.authority.map(v=>v.toString(16).padStart(2,'0')).join(''),retained=[{certificate:JSON.stringify(recipient),context:JSON.stringify(recipient.context),authority:recipientPin,write:true}];
    let destructive=false;try{await r.revision.stageCloudEpoch(r.vault,true,retained,{bytes,scope:r.scope,review,digest,destructive:false});}catch{destructive=true;}
    await r.revision.stageCloudEpoch(r.vault,true,retained,{bytes,scope:r.scope,review,digest,destructive:true});review.free();return destructive;
  },{target,recipient});assert(staged);
  for(const variant of ['ordinary','epoch','revision','signature','combined-root']){
    await window();const rejected=await page.evaluate(async variant=>{const r=globalThis.__needwareRelay,intent=r.revision.cloudEpochIntent(),next=JSON.parse(intent.next),cloud=next.cloud;
      const payload={action:'epoch_prepare',document:next.document,descriptor:cloud.descriptor,transition:intent.transition,checkpoint:intent.checkpoint,source_cursor:intent.sourceCursor,membership:cloud.membership,key_envelope:cloud.key_envelope,recipients:intent.recipients,schema_revision:true};
      if(variant==='ordinary')delete payload.schema_revision;
      if(variant==='epoch')payload.descriptor.binding.schema_epoch++;
      if(variant==='revision')payload.descriptor.binding.revision=JSON.parse(r.revision.binding()).revision;
      if(variant==='signature')payload.transition.signature[0]^=1;
      if(variant==='combined-root')payload.root_rotation={};
      try{await r.relay.request(payload);return 200;}catch(error){return error.status;}
    },variant);assert.equal(rejected,variant==='combined-root'?400:403);
  }
  assert.equal((await pool.query('SELECT document_id FROM needware_document_epoch WHERE document_id=$1',[initial.document])).rowCount,0);
  const trigger=`schema_fail_${crypto.randomUUID().replaceAll('-','')}`;
  await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${initial.document}' AND NEW.binding<>OLD.binding THEN RAISE EXCEPTION 'acceptance schema activation refused'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON needware_document FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try{await window();const rejected=await page.evaluate(async()=>{const r=globalThis.__needwareRelay;try{await r.relay.resumeEpoch(r.revision);return 200;}catch(error){return error.status;}});assert.equal(rejected,503);
    assert.deepEqual((await pool.query('SELECT binding FROM needware_document WHERE id=$1',[initial.document])).rows[0].binding,JSON.parse(initial.binding));
    assert.equal(await page.evaluate(()=>globalThis.__needwareRelay.revision.snapshot()),initial.state);
  }finally{await pool.query(`DROP TRIGGER ${trigger} ON needware_document`);await pool.query(`DROP FUNCTION ${trigger}()`);}
  await window();let dropped=false;
  const loseAck=async route=>{const payload=route.request().postDataJSON().payload;if(!dropped&&payload?.action==='epoch_activate'&&payload.document===initial.document){const response=await route.fetch();assert.equal(response.status(),200);dropped=true;await route.abort('failed');}else await route.continue();};
  await page.route(`${origin}/api/documents`,loseAck);
  try{assert(await page.evaluate(async()=>{const r=globalThis.__needwareRelay;try{await r.relay.resumeEpoch(r.revision);return false;}catch{return Boolean(r.revision.cloudEpochIntent());}}));assert(dropped);}finally{await page.unroute(`${origin}/api/documents`,loseAck);}
  await window();
  const published=await page.evaluate(async document=>{const r=globalThis.__needwareRelay,{DurableSyncSession}=await import('/sync-journal.js');await r.revision.close();r.revision=await DurableSyncSession.open(r.store.documents,r.vault,JSON.parse(r.vault.account_context()).account,document,true);await r.relay.resumeEpoch(r.revision);return JSON.parse(r.revision.binding());},initial.document);
  assert.equal(published.schema_epoch,2);assert.equal(published.generation,2);
  const frameCount=(await pool.query('SELECT count(*)::integer AS total FROM needware_document_frame WHERE document_id=$1',[initial.document])).rows[0].total;
  await window();
  const stale=await otherPage.evaluate(async document=>{const r=globalThis.__editableRelay;
    await r.revision.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Offline edit after migration'}},now:'2026-10-05T00:00:00Z',timezone:'UTC'}));r.oldState=r.revision.snapshot();r.oldPending=JSON.stringify(r.revision.pending());
    let stopped=false;try{await r.relay.synchronize(r.revision);}catch(error){stopped=error.status===409&&String(error).includes('Offline edits are preserved');if(!stopped)throw error;}
    let denied;try{await r.relay.request({action:'upload',document,frame:r.revision.pending()[0]});denied=200;}catch(error){denied=error.status;}
    return {stopped,denied,state:r.revision.snapshot()===r.oldState,pending:JSON.stringify(r.revision.pending())===r.oldPending};
  },initial.document);assert.deepEqual(stale,{stopped:true,denied:400,state:true,pending:true});
  assert.equal((await pool.query('SELECT count(*)::integer AS total FROM needware_document_frame WHERE document_id=$1',[initial.document])).rows[0].total,frameCount);
  await otherPage.evaluate(async()=>{const r=globalThis.__editableRelay;await r.revision.close();r.vault.free();r.store.close();});
  await window();await otherPage.goto(`${origin}/encrypted#account=${otherAccount}`);
  await expect(otherPage.getByText('Encrypted browser storage ready',{exact:true})).toBeVisible();
  await otherPage.locator(`[data-document="${initial.document}"]`).getByRole('button',{name:'Open Habit tracker',exact:true}).click();
  await otherPage.getByRole('button',{name:'Sync encrypted application',exact:true}).click();
  await expect(otherPage.getByRole('button',{name:'Review current shared revision',exact:true})).toBeVisible();
  await window();await otherPage.getByRole('button',{name:'Review current shared revision',exact:true}).click();
  const cloudReview=otherPage.getByRole('region',{name:'Cloud package review'});
  await expect(cloudReview.getByText(/2 offline changes remain/)).toBeVisible();
  await expect(cloudReview.getByRole('button',{name:'Trust signer and import cloud application',exact:true})).toBeDisabled();
  await cloudReview.getByRole('button',{name:'Cancel cloud import',exact:true}).click();
  await otherPage.goto(`${origin}/account`);
  await otherPage.evaluate(async({account,document})=>{const wasm=await import('/wasm/needware_wasm.js');await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import('/vault-store.js'),{DocumentRelay}=await import('/relay-client.js'),{DurableSyncSession}=await import('/sync-journal.js'),store=await openVaultStore(),root=await store.load(account),vault=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);
    const revision=await DurableSyncSession.open(store.documents,vault,account,document,true);globalThis.__editableRelay={wasm,store,vault,relay:new DocumentRelay(vault),revision,oldState:revision.snapshot()};
  },{account:otherAccount,document:initial.document});
  await window();
  const adopted=await otherPage.evaluate(async({document,pin,account})=>{const r=globalThis.__editableRelay,root=await r.store.load(account);root.bytes.fill(0);
    let proposal=await r.relay.prepareImport(r.store.documents,account,root.generation,document,pin,1,true),review=proposal.offlineReview(),explicit=false;
    try{await proposal.commit();}catch{explicit=true;}
    const reviewExact=review.pending===2&&review.state===r.oldState;
    await r.revision.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Edit during review'}},now:'2026-10-05T00:00:00Z',timezone:'UTC'}));r.oldState=r.revision.snapshot();
    let raced=false;try{await proposal.commit(true);}catch{raced=true;}proposal.close();
    proposal=await r.relay.prepareImport(r.store.documents,account,root.generation,document,pin,1,true);const current=await proposal.commit(true);proposal.close();await r.revision.close();r.revision=current;
    const {DurableSyncSession}=await import('/sync-journal.js');await current.close();r.revision=await DurableSyncSession.open(r.store.documents,r.vault,account,document,true);
    const history=r.revision.recoveryHistory(),entry=history.at(-1),info=JSON.parse(r.wasm.inspect_package(entry.package));
    return {explicit,reviewExact,raced,preserved:entry.state===r.oldState,pending:entry.pending,oldRevision:info.application.revision,current:JSON.parse(r.revision.binding()).revision,schema:JSON.parse(r.revision.binding()).schema_epoch,state:r.revision.snapshot()};
  },{...initial,account:otherAccount});
  assert(adopted.explicit&&adopted.reviewExact&&adopted.raced&&adopted.preserved);assert.equal(adopted.pending,3);assert.notEqual(adopted.oldRevision,adopted.current);assert.equal(adopted.schema,2);assert(adopted.state.includes('Shared source'));assert(!adopted.state.includes('Offline edit'));
  await window();await otherPage.evaluate(async()=>{const r=globalThis.__editableRelay;await r.revision.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Fresh schema edit'}},now:'2026-10-05T00:00:00Z',timezone:'UTC'}));await r.relay.synchronize(r.revision);});
  await window();assert((await page.evaluate(async()=>{const r=globalThis.__needwareRelay;await r.relay.synchronize(r.revision);return r.revision.snapshot();})).includes('Fresh schema edit'));
  await otherPage.goto(`${origin}/encrypted#account=${otherAccount}`);
  await expect(otherPage.getByText('Encrypted browser storage ready',{exact:true})).toBeVisible();
  await otherPage.locator(`[data-document="${initial.document}"]`).getByRole('button',{name:'Open Habit tracker revised',exact:true}).click();
  await expect(otherPage.frameLocator('iframe').getByText('Fresh schema edit',{exact:true})).toBeVisible();
  await otherPage.getByText('Recovery history',{exact:true}).click();await otherPage.getByRole('button',{name:'Review recovery history',exact:true}).click();
  await expect(otherPage.getByText(/3 preserved offline changes/)).toBeVisible();
  await expect(otherPage.getByRole('button',{name:'Export recovery data 1',exact:true})).toBeVisible();
  console.log('PASS cloud schema: exact signed cut, destructive consent, rollback, lost acknowledgment, stale-key denial, explicit retained offline review, concurrent edit CAS and cold reopen');
}
