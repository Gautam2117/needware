import {test,expect} from './fixtures';

test('owner epoch journals publish atomically, retain original history and recover offline with fresh keys', async({page,offlineServer})=>{
  test.setTimeout(180_000);
  await page.goto(offlineServer.url);
  const saved=await page.evaluate(async()=>{
    const wasmPath='/wasm/needware_wasm.js',storePath='/vault-store.js',journalPath='/sync-journal.js';
    const wasm=await import(wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import(storePath),{DurableSyncSession}=await import(journalPath);
    const account=crypto.randomUUID(),vault=new wasm.BrowserVault(account),store=await openVaultStore();
    const backup=vault.local_backup();await store.save(account,backup,null);backup.fill(0);
    const bytes=wasm.authored_sync_example(),scope=JSON.stringify({values:[],collections:['habits']});
    const original=vault.start_document(bytes,crypto.randomUUID(),scope,1,true),binding=original.binding(),document=JSON.parse(binding).document.document,pin=vault.account_authority();
    const journal=await DurableSyncSession.create(store.documents,vault,bytes,original,{account,rootGeneration:1,scope,ownerEpoch:1,authority:pin,roster:JSON.stringify([JSON.parse(original.membership())])});
    const event=(action:string,values:unknown)=>JSON.stringify({action,values,now:'2026-10-04T00:00:00Z',timezone:'UTC'});
    const records:string[]=[];
    for(let i=0;i<96;i++){const record=crypto.randomUUID();records.push(record);await journal.dispatch(event('add',{record_id:{type:'string',value:record},name:{type:'string',value:`Epoch record ${i}`}}));}
    const oldFrame=journal.pending()[0],oldState=journal.snapshot();
    const oldBackup=vault.local_backup(),staleVault=wasm.BrowserVault.from_local_backup(oldBackup);oldBackup.fill(0);
    const stale=await DurableSyncSession.open(store.documents,staleVault,account,document,true);
    await journal.dispatch(event('toggle',{record_id:{type:'string',value:records[0]}}));
    let staleRejected=false;try{await stale.compactLocal(staleVault,true);}catch{staleRejected=true;}
    const stalePreserved=stale.snapshot()===oldState&&JSON.parse(staleVault.held_document_key_backup(document)).document.epoch===1;
    const before=journal.snapshot();let consentRejected=false;try{await journal.compactLocal(vault,false);}catch{consentRejected=true;}
    if(journal.snapshot()!==before)throw new Error('Rejected epoch changed live state');
    await journal.compactLocal(vault,true);
    const epochTwo=JSON.parse(journal.binding()).generation===2&&journal.snapshot()===before&&journal.pending().length===0;
    const savedJournal=await store.documents.load(account,document);let parsed;
    try{parsed=JSON.parse(new TextDecoder().decode(savedJournal.bytes));}finally{savedJournal.bytes.fill(0);}
    const archived=JSON.parse(parsed.archive[0]);
    const archiveBackup=vault.local_backup(),archiveVault=wasm.BrowserVault.from_local_backup(archiveBackup);archiveBackup.fill(0);
    archiveVault.forget_document(document);archiveVault.restore_held_document_key(archived.held,JSON.stringify(JSON.parse(archived.binding).document));
    const historical=archiveVault.open_shared_document(bytes,document,archived.membership,1,pin,1,scope,1,true);
    historical.set_roster(archived.roster);for(const frame of archived.frames)historical.receive(frame);
    historical.restore_local_state(archived.state);
    const archivePreserved=parsed.archive.length===1&&archived.queued[0]===oldFrame&&historical.snapshot()===before;
    historical.free();archiveVault.free();
    if(atob(parsed.epoch.checkpoint).length<=32768)throw new Error('Checkpoint did not exercise the larger bounded decoder');
    await stale.close();
    // A tab retaining the previous key can authenticate the durable checkpoint
    // before activating the new key; a bad journal cannot downgrade it.
    const advanced=await DurableSyncSession.open(store.documents,staleVault,account,document,true);
    const staleKeyAdvanced=JSON.parse(staleVault.held_document_key_backup(document)).document.epoch===2&&advanced.snapshot()===before;
    await advanced.close();staleVault.free();
    const reader=new wasm.BrowserVault(crypto.randomUUID());
    const offer=vault.offer_document(document,reader.device_certificate(),reader.account_context(),reader.account_authority(),false,true);
    const proposal=JSON.parse(offer),nextContext=JSON.stringify(proposal.membership.document);
    const readOnly=reader.join_document(bytes,offer,nextContext,1,pin,2,scope,1,true);
    readOnly.set_roster(JSON.stringify([JSON.parse(parsed.membership),proposal.membership]));
    const checkpoint=Uint8Array.from(atob(parsed.epoch.checkpoint),(char:string)=>char.charCodeAt(0));
    readOnly.install_epoch(checkpoint,binding);checkpoint.fill(0);
    const readerRecovered=readOnly.snapshot()===before;
    let readOnlyRejected=false;try{readOnly.dispatch(event('toggle',{record_id:{type:'string',value:records[0]}}));}catch{readOnlyRejected=true;}
    await journal.dispatch(event('toggle',{record_id:{type:'string',value:records[0]}}));
    readOnly.receive(journal.pending()[0]);
    const readerConverged=readOnly.snapshot()===journal.snapshot();
    const current=journal.snapshot();let oldFrameRejected=false;try{await journal.receive([oldFrame],'bad-old-cursor');}catch{oldFrameRejected=true;}
    const oldFramePreserved=journal.snapshot()===current&&journal.cursor()===null;
    await journal.close();readOnly.free();reader.free();vault.free();store.close();
    return {account,document,state:current,staleRejected,stalePreserved,consentRejected,epochTwo,archivePreserved,staleKeyAdvanced,readerRecovered,readOnlyRejected,readerConverged,oldFrameRejected,oldFramePreserved};
  });
  expect(saved).toMatchObject({staleRejected:true,stalePreserved:true,consentRejected:true,epochTwo:true,archivePreserved:true,staleKeyAdvanced:true,readerRecovered:true,readOnlyRejected:true,readerConverged:true,oldFrameRejected:true,oldFramePreserved:true});
  await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);await offlineServer.stop();await page.reload();
  const reopened=await page.evaluate(async saved=>{
    const wasmPath='/wasm/needware_wasm.js',storePath='/vault-store.js',journalPath='/sync-journal.js';
    const wasm=await import(wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import(storePath),{DurableSyncSession}=await import(journalPath);
    const store=await openVaultStore(),root=await store.load(saved.account),vault=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);
    const journal=await DurableSyncSession.open(store.documents,vault,saved.account,saved.document,true);
    const result={state:journal.snapshot(),generation:JSON.parse(journal.binding()).generation,pending:journal.pending().length};
    await journal.close();vault.free();store.close();return result;
  },saved);
  expect(reopened).toEqual({state:saved.state,generation:2,pending:1});
});
