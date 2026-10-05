import assert from 'node:assert/strict';
export async function prepareForeignRoot({page,otherPage,recoveredPage,enrolledPage,account,otherAccount}){
  const ownerCertificate=await page.evaluate(()=>JSON.parse(globalThis.__needwareRelay.vault.device_certificate()));
  const retainedCertificate=await recoveredPage.evaluate(()=>JSON.parse(globalThis.__retainedRoot.vault.device_certificate()));
  const removedCertificate=await enrolledPage.evaluate(async account=>{
    const wasm=await import('/wasm/needware_wasm.js');await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import('/vault-store.js'),{DocumentRelay}=await import('/relay-client.js'),store=await openVaultStore(),saved=await store.load(account),vault=wasm.BrowserVault.from_local_backup(saved.bytes);saved.bytes.fill(0);
    globalThis.__foreignRoot={wasm,store,vault,relay:new DocumentRelay(vault)};return JSON.parse(vault.device_certificate());
  },account);
  const foreign=await otherPage.evaluate(async({certificates,account})=>{
    const r=globalThis.__editableRelay,{DurableSyncSession}=await import('/sync-journal.js'),bytes=r.wasm.authored_sync_example(),scope=JSON.stringify({values:[],collections:['habits']}),native=r.vault.start_document(bytes,crypto.randomUUID(),scope,1,true),saved=await r.store.load(account);saved.bytes.fill(0);
    const journal=await DurableSyncSession.create(r.store.documents,r.vault,bytes,native,{account,rootGeneration:saved.generation,scope,ownerEpoch:1,authority:r.vault.account_authority(),roster:JSON.stringify([JSON.parse(native.membership())])});
    await journal.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Foreign owner original record'}},now:'2026-10-05T00:00:00Z',timezone:'UTC'}));await r.relay.synchronize(journal);await r.relay.synchronize(journal);
    const document=JSON.parse(journal.binding()).document.document;
    for(const certificate of certificates){const pin=certificate.authority.map(byte=>byte.toString(16).padStart(2,'0')).join(''),offer=JSON.parse(r.vault.offer_document(document,JSON.stringify(certificate),JSON.stringify(certificate.context),pin,true,true));await r.relay.request({action:'grant',document,recipient:certificate,membership:offer.membership,key_envelope:{kind:'offer',value:offer}});}
    r.foreignRootJournal=journal;return {document,pin:r.vault.account_authority()};
  },{certificates:[ownerCertificate,retainedCertificate,removedCertificate],account:otherAccount});
  await enrolledPage.evaluate(async({foreign,account})=>{const r=globalThis.__foreignRoot,saved=await r.store.load(account);saved.bytes.fill(0);
    r.journal=await r.relay.importDocument(r.store.documents,account,saved.generation,foreign.document,foreign.pin,1,true);
    const add=name=>JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:name}},now:'2026-10-05T00:00:00Z',timezone:'UTC'});
    await r.journal.dispatch(add('Original author later removed by root rotation'));await r.relay.synchronize(r.journal);await r.relay.synchronize(r.journal);
    await r.journal.dispatch(add('Preserved stale offline work after removal'));r.originalState=r.journal.snapshot();r.originalQueued=JSON.stringify(r.journal.pending());
  },{foreign,account});
  await otherPage.evaluate(async()=>{const r=globalThis.__editableRelay;await r.relay.synchronize(r.foreignRootJournal);});
  await page.evaluate(async({foreign,account})=>{const r=globalThis.__needwareRelay,saved=await r.store.load(account);saved.bytes.fill(0);const journal=await r.relay.importDocument(r.store.documents,account,saved.generation,foreign.document,foreign.pin,1,true);await journal.close();}, {foreign,account});
  return foreign;
}
export async function finishForeignRoot({page,otherPage,recoveredPage,enrolledPage,pool,account,otherAccount,foreign,plan}){
  assert.equal((await pool.query('SELECT document_id FROM needware_document_rekey WHERE document_id=$1',[foreign.document])).rowCount,1);
  const paused=await otherPage.evaluate(async()=>{const r=globalThis.__editableRelay;try{await r.relay.request({action:'upload',document:JSON.parse(r.foreignRootJournal.binding()).document.document,frame:r.foreignRootJournal.pending()[0]??'{}'});return 200;}catch(error){return error.status;}});assert.equal(paused,409);
  await otherPage.evaluate(async devices=>{const r=globalThis.__editableRelay,recipients=devices.map(device=>({certificate:JSON.stringify(device.certificate),context:JSON.stringify(device.certificate.context),authority:device.certificate.authority.map(byte=>byte.toString(16).padStart(2,'0')).join(''),write:true}));await r.relay.rotateEpoch(r.foreignRootJournal,true,recipients);},plan.devices);
  assert.equal((await pool.query('SELECT document_id FROM needware_document_rekey WHERE document_id=$1',[foreign.document])).rowCount,0);
  const current=await otherPage.evaluate(()=>{const r=globalThis.__editableRelay;return {state:r.foreignRootJournal.snapshot(),document:JSON.parse(r.foreignRootJournal.binding()).document.document};});
  const recovered=await recoveredPage.evaluate(async({foreign,account})=>{const r=globalThis.__retainedRoot,{DocumentRelay}=await import('/relay-client.js'),saved=await r.store.load(account);saved.bytes.fill(0);const journal=await new DocumentRelay(r.current).importDocument(r.store.documents,account,saved.generation,foreign.document,foreign.pin,1,true);try{return journal.snapshot();}finally{await journal.close();}}, {foreign,account});assert.equal(recovered,current.state);
  const encrypted=await otherPage.evaluate(async document=>{const r=globalThis.__editableRelay;return (await r.relay.request({action:'download',document,index:0})).ciphertext;},foreign.document);
  const excluded=await enrolledPage.evaluate(async({foreign,encrypted})=>{const r=globalThis.__foreignRoot,cipher=Uint8Array.from(atob(encrypted),char=>char.charCodeAt(0));let denied=false;try{r.vault.open_document_payload(foreign.document,cipher,`NEEDWARE-CLOUD-PACKAGE-v1:${foreign.document}`);}catch{denied=true;}finally{cipher.fill(0);}
    let status;try{await r.relay.synchronize(r.journal);status=200;}catch(error){status=error.status;}
    return {denied,status,preserved:r.journal.snapshot()===r.originalState&&JSON.stringify(r.journal.pending())===r.originalQueued};
  },{foreign,encrypted});assert.deepEqual(excluded,{denied:true,status:403,preserved:true});
  for(const owner of [account,otherAccount]){const usage=await pool.query('SELECT u.bytes,(SELECT COALESCE(sum(storage_bytes),0) FROM needware_document WHERE owner_id=$1)+(SELECT COALESCE(sum(metadata_bytes),0) FROM needware_root_rotation WHERE account_id=$1) AS actual FROM needware_relay_usage u WHERE account_id=$1',[owner]);assert.equal(String(usage.rows[0].bytes),String(usage.rows[0].actual));}
  console.log('PASS foreign-owner pause, actual fresh-key cut, retained Root2 HPKE import, original removed-author history, old-key cryptographic denial and untouched offline outbox');
}
