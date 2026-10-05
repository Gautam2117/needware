import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {prepareForeignRoot,finishForeignRoot} from './verify_foreign_root.mjs';
import {verifyRootUI} from './verify_root_ui.mjs';
import {advanceAcceptanceWindow} from './acceptance-clock.mjs';
const require=createRequire(new URL('../apps/web/package.json',import.meta.url));
const {default:canonicalize}=await import(require.resolve('canonicalize'));
async function rateWindow(pool,account){
  if(await advanceAcceptanceWindow(pool,{account}))return;
  const row=await pool.query('SELECT count,reset_at FROM needware_account_limit WHERE account_id=$1',[account]);
  if(row.rowCount&&row.rows[0].count>12){const wait=Math.max(0,new Date(row.rows[0].reset_at).getTime()-Date.now()+100);if(wait)await new Promise(resolve=>setTimeout(resolve,Math.min(wait,60_000)));}
  for(;;){const pending=await pool.query('SELECT count(*)::integer AS total,min(expires_at) AS earliest FROM needware_vault_challenge WHERE account_id=$1 AND expires_at>now()',[account]);if(pending.rows[0].total<6)break;const wait=Math.max(0,new Date(pending.rows[0].earliest).getTime()-Date.now()+100);if(wait)await new Promise(resolve=>setTimeout(resolve,Math.min(wait,60_000)));}
}
async function rootRequest(page,payload,next=false){
  const serialized=canonicalize(payload),digest=createHash('sha256').update(serialized).digest('hex');
  const prepared=await page.evaluate(async({digest,next})=>{
    const r=globalThis.__needwareRelay,vault=next?r.rootCandidate:r.vault;
    const challenge=await fetch('/api/vault/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'rotate_root'})});
    const nonce=await challenge.json();if(!challenge.ok)return {status:challenge.status,body:nonce};
    const proof=JSON.parse(vault.account_operation(nonce.nonce,JSON.stringify('rotate_root'),digest));
    return {proof};
  },{digest,next});
  if(!prepared.proof)return prepared;
  return page.evaluate(async body=>{const response=await fetch('/api/vault/rotation',{method:'POST',headers:{'Content-Type':'application/json'},body});return {status:response.status,body:await response.json()};},canonicalize({proof:prepared.proof,payload:JSON.parse(serialized)}));
}
export async function verifyCloudRoots({page,otherPage,recoveredPage,enrolledPage,pool,account,otherAccount,origin,email,password}){
  console.log('Cloud root acceptance: two owned documents and independently retained device');
  await rateWindow(pool,account);
  const retained=await recoveredPage.evaluate(async account=>{
    const wasm=await import('/wasm/needware_wasm.js');await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import('/vault-store.js'),store=await openVaultStore(),saved=await store.load(account),vault=wasm.BrowserVault.from_local_backup(saved.bytes);saved.bytes.fill(0);
    globalThis.__retainedRoot={wasm,store,vault};return vault.device_public();
  },account);
  const foreign=await prepareForeignRoot({page,otherPage,recoveredPage,enrolledPage,account,otherAccount});
  await rateWindow(pool,account);
  const plan=await page.evaluate(async retained=>{
    const r=globalThis.__needwareRelay,{DurableSyncSession}=await import('/sync-journal.js'),scope=JSON.stringify({values:[],collections:['habits']}),account=JSON.parse(r.vault.account_context()).account;
    const root=await r.store.load(account);root.bytes.fill(0);r.rootJournals=[];
    for(let index=0;index<2;index++){
      const bytes=r.wasm.authored_sync_example(),native=r.vault.start_document(bytes,crypto.randomUUID(),scope,1,true);
      const journal=await DurableSyncSession.create(r.store.documents,r.vault,bytes,native,{account,rootGeneration:root.generation,scope,ownerEpoch:1,authority:r.vault.account_authority(),roster:JSON.stringify([JSON.parse(native.membership())])});
      await journal.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:`Root publication document ${index}`}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));
      await r.relay.synchronize(journal);await r.relay.synchronize(journal);r.rootJournals.push(journal);
    }
    r.rootRotation=r.vault.prepare_root_rotation(true);r.rootCandidate=r.rootRotation.preview();
    const approval=JSON.parse(r.rootCandidate.approve_device(retained,true)),certificate=approval.certificate,id=crypto.randomUUID(),recovery=JSON.parse(r.rootCandidate.create_recovery(true));
    r.rootCuts=[];for(const journal of r.rootJournals)r.rootCuts.push(await journal.prepareCloudRootCut(r.rootCandidate,r.rootRotation,id,[{certificate:JSON.stringify(certificate),context:JSON.stringify(certificate.context),authority:r.rootCandidate.account_authority(),write:true}],true));
    const proof=JSON.parse(r.rootRotation.proof()),devices=[{certificate:JSON.parse(r.rootCandidate.device_certificate()),approval:null},{certificate,approval}],sources=r.rootCuts.map(cut=>cut.source),publicPlan={action:'prepare',id,proof,recovery:recovery.envelope,devices,sources},local=[];
    for(const document of await r.store.documents.list(account)){if(sources.some(source=>source.document===document))continue;const journal=await DurableSyncSession.open(r.store.documents,r.vault,account,document,true);try{local.push(JSON.parse(journal.binding()).document.account===account?await journal.prepareLocalRootCut(r.rootCandidate,r.rootRotation,true):await journal.prepareForeignRootCut(r.rootCandidate,r.rootRotation,true));}finally{await journal.close();}}
    const {RootPublication}=await import('/root-publication.js');r.rootPublication=new RootPublication(r.store,r.vault);await r.rootPublication.stage(r.rootCandidate,publicPlan,local,r.rootCuts,true);
    r.rootLocalStates=local.map(cut=>({document:cut.document,state:JSON.parse(new TextDecoder().decode(cut.bytes)).state}));
    for(const cut of local)cut.bytes.fill(0);
    return {id,proof,recovery:recovery.envelope,devices,sources,states:r.rootJournals.map(journal=>journal.snapshot()),context:r.rootCandidate.account_context(),pin:r.rootCandidate.account_authority()};
  },retained);
  const before=(await pool.query('SELECT context,authority FROM needware_account_vault WHERE account_id=$1',[account])).rows[0];
  const publicPlan={action:'prepare',id:plan.id,proof:plan.proof,recovery:plan.recovery,devices:plan.devices,sources:plan.sources};
  for(const variant of ['signature','duplicate','missing-source']){
    await rateWindow(pool,account);const invalid=structuredClone(publicPlan);
    if(variant==='signature')invalid.proof.acceptance[0]^=1;
    if(variant==='duplicate')invalid.devices.push(structuredClone(invalid.devices[0]));
    if(variant==='missing-source')invalid.sources.pop();
    const rejected=await rootRequest(page,invalid);assert.equal(rejected.status,variant==='duplicate'?400:variant==='missing-source'?409:403,JSON.stringify(rejected));
  }
  await rateWindow(pool,account);
  const quota=(await pool.query('SELECT bytes FROM needware_relay_usage WHERE account_id=$1',[account])).rows[0];
  await pool.query('UPDATE needware_relay_usage SET bytes=134217728 WHERE account_id=$1',[account]);
  try{const rejected=await rootRequest(page,publicPlan);assert.equal(rejected.status,409,JSON.stringify(rejected));assert.equal((await pool.query('SELECT id FROM needware_root_rotation WHERE account_id=$1',[account])).rowCount,0);}
  finally{await pool.query('UPDATE needware_relay_usage SET bytes=$2 WHERE account_id=$1',[account,quota.bytes]);}
  await rateWindow(pool,account);
  assert.equal((await rootRequest(page,{action:'prepare',id:plan.id,proof:plan.proof,recovery:plan.recovery,devices:plan.devices,sources:plan.sources})).status,200);
  const incomplete=await rootRequest(page,{action:'activate',id:plan.id});assert.equal(incomplete.status,409,JSON.stringify(incomplete));
  assert.deepEqual((await pool.query('SELECT context,authority FROM needware_account_vault WHERE account_id=$1',[account])).rows[0],before);
  await rateWindow(pool,account);
  await page.evaluate(async()=>{const r=globalThis.__needwareRelay;
    for(const cut of r.rootCuts){await r.relay.request(cut.prepare);const next=JSON.parse(new TextDecoder().decode(cut.cut.bytes));
      for(const [kind,encoded] of [['package',next.cloud.ciphertext],['checkpoint',next.epoch.checkpoint]]){
        const bytes=Uint8Array.from(atob(encoded),char=>char.charCodeAt(0));try{for(let offset=0;offset<bytes.length;offset+=1048576){const chunk=bytes.subarray(offset,offset+1048576);let text='';for(let index=0;index<chunk.length;index+=8192)text+=String.fromCharCode(...chunk.subarray(index,index+8192));
          await r.relay.request({action:'epoch_chunk',document:next.document,generation:2,root_rotation:cut.prepare.root_rotation,kind,index:offset/1048576,ciphertext:btoa(text)});
        }}finally{bytes.fill(0);}
      }
    }
  });
  const docs=plan.sources.map(source=>source.document).sort(),fixture=crypto.randomUUID().replaceAll('-',''),name=`root_fail_${fixture}`;
  const ledger=(await pool.query('SELECT bytes FROM needware_relay_usage WHERE account_id=$1',[account])).rows[0];
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${docs[1]}' AND NEW.binding<>OLD.binding THEN RAISE EXCEPTION 'acceptance second root document refused'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON needware_document FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{
    const failed=await rootRequest(page,{action:'activate',id:plan.id});assert.equal(failed.status,503,JSON.stringify(failed));
    assert.deepEqual((await pool.query('SELECT context,authority FROM needware_account_vault WHERE account_id=$1',[account])).rows[0],before);
    assert((await pool.query('SELECT binding FROM needware_document WHERE id=ANY($1::uuid[])',[docs])).rows.every(row=>row.binding.generation===1));
    assert.deepEqual((await pool.query('SELECT bytes FROM needware_relay_usage WHERE account_id=$1',[account])).rows[0],ledger);
  }finally{await pool.query(`DROP TRIGGER ${name} ON needware_document`);await pool.query(`DROP FUNCTION ${name}()`);}
  console.log('Cloud root acceptance: second-document database failure rolled back root, documents and quota');
  await rateWindow(pool,account);
  let dropped=false;
  const loseAck=async route=>{if(!dropped&&route.request().postDataJSON().payload.action==='activate'){const response=await route.fetch();assert.equal(response.status(),200);dropped=true;await route.abort('failed');}else await route.continue();};
  await page.route(`${origin}/api/vault/rotation`,loseAck);
  try{await assert.rejects(rootRequest(page,{action:'activate',id:plan.id}));}finally{await page.unroute(`${origin}/api/vault/rotation`,loseAck);}assert(dropped);
  assert.equal((await pool.query('SELECT status FROM needware_root_rotation WHERE account_id=$1 AND id=$2',[account,plan.id])).rows[0].status,'active');
  assert.equal((await rootRequest(page,{action:'status',id:plan.id})).status,403);
  assert.equal((await rootRequest(page,{action:'activate',id:plan.id},true)).status,200);
  assert.equal((await pool.query('SELECT device_id FROM needware_vault_device WHERE account_id=$1',[account])).rowCount,2);
  const directory=await page.evaluate(async()=>{const response=await fetch('/api/vault');return response.status;});assert.equal(directory,200);
  const published=await page.evaluate(async()=>{const r=globalThis.__needwareRelay,{RootPublication}=await import('/root-publication.js'),{DurableSyncSession}=await import('/sync-journal.js');const result=await new RootPublication(r.store,r.vault).resume();
    const saved=await r.store.load(JSON.parse(r.vault.account_context()).account),cold=r.wasm.BrowserVault.from_local_backup(saved.bytes);saved.bytes.fill(0);const states=[];
    try{for(const cut of [...r.rootCuts.map(cut=>({document:cut.cut.document})),...r.rootLocalStates]){const journal=await DurableSyncSession.open(r.store.documents,cold,JSON.parse(cold.account_context()).account,cut.document,true);states.push(journal.snapshot());await journal.close();}return {...result,context:cold.account_context(),states,privateStates:r.rootLocalStates.map(cut=>cut.state),pending:Boolean(await r.store.rotations.load(JSON.parse(cold.account_context()).account))};}finally{cold.free();}
  });assert.equal(published.context,plan.context);assert(!published.pending);assert.deepEqual(published.states,[...plan.states,...published.privateStates]);
  await rateWindow(pool,account);
  const recovered=await recoveredPage.evaluate(async plan=>{
    const r=globalThis.__retainedRoot,{DocumentRelay}=await import('/relay-client.js'),approval=plan.devices.find(device=>device.approval).approval;
    const rotation=r.vault.accept_root_rotation(JSON.stringify(plan.proof),JSON.stringify(approval),plan.context,plan.pin),candidate=rotation.preview(),relay=new DocumentRelay(candidate);
    const states=[];for(const source of plan.sources){const root=await r.store.load(JSON.parse(candidate.account_context()).account);root.bytes.fill(0);const journal=await relay.importDocument(r.store.documents,JSON.parse(candidate.account_context()).account,root.generation,source.document,plan.pin,2,true);states.push(journal.snapshot());await journal.close();}
    r.current=candidate;rotation.free();return states;
  },plan);assert.deepEqual(recovered,plan.states);
  const oldDenied=await enrolledPage.evaluate(async document=>{const wasm=await import('/wasm/needware_wasm.js');await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});const {openVaultStore}=await import('/vault-store.js'),{DocumentRelay}=await import('/relay-client.js'),store=await openVaultStore(),account=(await(await fetch('/api/auth/get-session')).json()).user.id,saved=await store.load(account),vault=wasm.BrowserVault.from_local_backup(saved.bytes);saved.bytes.fill(0);
    try{await new DocumentRelay(vault).request({action:'read',document,cursor:'0'});return 200;}catch(error){return error.status;}finally{vault.free();store.close();}
  },docs[0]);assert.equal(oldDenied,403);
  const cryptoDenied=await page.evaluate(()=>{const r=globalThis.__needwareRelay;return r.rootCuts.every(cut=>{const next=JSON.parse(new TextDecoder().decode(cut.cut.bytes)),cipher=Uint8Array.from(atob(next.cloud.ciphertext),char=>char.charCodeAt(0));try{r.vault.open_document_payload(next.document,cipher,`NEEDWARE-CLOUD-PACKAGE-v1:${next.document}`);return false;}catch{return true;}finally{cipher.fill(0);}});});assert(cryptoDenied);
  const usage=await pool.query('SELECT u.bytes,(SELECT COALESCE(sum(storage_bytes),0) FROM needware_document WHERE owner_id=$1)+(SELECT COALESCE(sum(metadata_bytes),0) FROM needware_root_rotation WHERE account_id=$1) AS actual FROM needware_relay_usage u WHERE account_id=$1',[account]);assert.equal(String(usage.rows[0].bytes),String(usage.rows[0].actual));
  await rateWindow(pool,account);await rateWindow(pool,otherAccount);
  await finishForeignRoot({page,otherPage,recoveredPage,enrolledPage,pool,account,otherAccount,foreign,plan});
  await rateWindow(pool,account);await rateWindow(pool,otherAccount);
  await verifyRootUI({page,otherPage,recoveredPage,pool,account,origin,email,password,document:plan.sources[0].document,waitForWindow:()=>rateWindow(pool,account)});
  console.log('PASS real cloud root publication, atomic rollback, idempotent current-root retry, retained HPKE checkpoint import, old-root ciphertext denial and exact storage ledger');
}
