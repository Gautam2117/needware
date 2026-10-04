import { test, expect } from './fixtures';

test('root and every journal publish atomically after offline restart, preserving originals on failure', async ({ page, offlineServer }) => {
  test.setTimeout(180_000);
  await page.goto(offlineServer.url);
  const saved = await page.evaluate(async () => {
    const wasmPath='/wasm/needware_wasm.js',storePath='/vault-store.js',journalPath='/sync-journal.js';
    const wasm=await import(wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import(storePath),{DurableSyncSession}=await import(journalPath);
    const account=crypto.randomUUID(),vault=new wasm.BrowserVault(account),store=await openVaultStore();
    const encode=(bytes:Uint8Array)=>{const parts:string[]=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));return btoa(parts.join(''));};
    const backup=vault.local_backup();await store.save(account,backup,null);backup.fill(0);
    const bytes=wasm.authored_sync_example(),scope=JSON.stringify({values:[],collections:['habits']}),sessions:any[]=[],documents:string[]=[],states:string[]=[];
    for(let i=0;i<2;i++){
      const native=vault.start_document(bytes,crypto.randomUUID(),scope,1,true),document=JSON.parse(native.binding()).document.document;
      const journal=await DurableSyncSession.create(store.documents,vault,bytes,native,{account,rootGeneration:1,scope,ownerEpoch:1,authority:vault.account_authority(),roster:JSON.stringify([JSON.parse(native.membership())])});
      await journal.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:`Root rotation document ${i}`}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));
      sessions.push({native,journal});documents.push(document);states.push(journal.snapshot());
    }
    const rotation=vault.prepare_root_rotation(true),candidate=rotation.preview(),cuts:any[]=[];
    for(let i=0;i<documents.length;i++){
      const saved=await store.documents.load(account,documents[i]);saved.bytes.fill(0);
      const cut=await sessions[i].journal.prepareLocalRootCut(candidate,rotation,true);if(cut.generation!==saved.generation)throw new Error('Root preparation ignored source generation');cuts.push(cut);
    }
    const nextBackup=candidate.local_backup(),intentBytes=new TextEncoder().encode(JSON.stringify({backup:encode(nextBackup),cuts:cuts.map(cut=>({...cut,bytes:encode(cut.bytes)})),proof:rotation.proof()})),id=crypto.randomUUID(),sources=cuts.map(({document,generation})=>({document,generation}));
    const opening=indexedDB.open('needware-vault-1',2),db:IDBDatabase=await new Promise((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error);});
    const read=async(name:string,key:IDBValidKey):Promise<any>=>{const req=db.transaction(name).objectStore(name).get(key);return await new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});};
    const write=async(name:string,value:any)=>{const tx=db.transaction(name,'readwrite');tx.objectStore(name).put(value);await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});};
    const originalQuota=await read('document-quotas',account),originalRoot=await read('vaults',account);
    await write('document-quotas',{...originalQuota,bytes:128*1024*1024});let quotaRejected=false;try{await store.rotations.stage(account,id,intentBytes,1,sources);}catch{quotaRejected=true;}await write('document-quotas',originalQuota);
    if((await read('vaults',account)).rotation)throw new Error('Quota failure staged a root');
    let sourceRejected=false;try{await store.rotations.stage(account,id,intentBytes,1,sources.slice(1));}catch{sourceRejected=true;}
    await store.rotations.stage(account,id,intentBytes,1,sources);
    const stagedRoot=await read('vaults',account),stagedQuota=await read('document-quotas',account);
    const charged=stagedQuota.bytes===originalQuota.bytes+intentBytes.byteLength+16;
    let vaultBlocked=false,journalBlocked=false,removeBlocked=false;
    try{await store.save(account,nextBackup,1);}catch{vaultBlocked=true;}
    try{await sessions[0].journal.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Must not publish'}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));}catch{journalBlocked=true;}
    try{await store.documents.remove(account,documents[0],sources[0].generation,1);}catch{removeBlocked=true;}
    const livePreserved=sessions.every((item,index)=>item.journal.snapshot()===states[index]);
    const corrupt=structuredClone(stagedRoot);new Uint8Array(corrupt.rotation.ciphertext)[0]^=1;await write('vaults',corrupt);
    let tamperRejected=false,tamperPublishRejected=false;try{await store.rotations.load(account);}catch{tamperRejected=true;}
    try{await store.rotations.publish(account,id,nextBackup,1,cuts);}catch{tamperPublishRejected=true;}
    const stillOriginal=await store.load(account),originalVault=wasm.BrowserVault.from_local_backup(stillOriginal.bytes),originalReadable=stillOriginal.generation===1&&originalVault.account_context()===vault.account_context();originalVault.free();stillOriginal.bytes.fill(0);await write('vaults',stagedRoot);
    let incompleteRejected=false;try{await store.rotations.publish(account,id,nextBackup,1,cuts.slice(1));}catch{incompleteRejected=true;}
    const originalPut=IDBObjectStore.prototype.put;let writes=0,injected=false;
    IDBObjectStore.prototype.put=function(value:any,key?:IDBValidKey){if(this.name==='documents'&&++writes===2){injected=true;throw new Error('Injected second document write failure');}return key===undefined?originalPut.call(this,value):originalPut.call(this,value,key);};
    let failureRejected=false;try{await store.rotations.publish(account,id,nextBackup,1,cuts);}catch{failureRejected=true;}finally{IDBObjectStore.prototype.put=originalPut;}
    const afterFailure=await read('vaults',account),failureAtomic=afterFailure.generation===1&&afterFailure.rotation.id===id&&(await read('document-quotas',account)).bytes===stagedQuota.bytes;
    for(const source of sources)if((await read('documents',[account,source.document])).generation!==source.generation)throw new Error('Partial root publication escaped transaction');
    await store.rotations.cancel(account,id,1);
    const refunded=(await read('document-quotas',account)).bytes===originalQuota.bytes&&(await read('vaults',account)).rotation===undefined;
    await store.rotations.stage(account,id,intentBytes,1,sources);
    const pending=await store.rotations.load(account),intentRoundtrip=new TextDecoder().decode(pending.bytes)===new TextDecoder().decode(intentBytes);pending.bytes.fill(0);
    for(const item of sessions)await item.journal.close();nextBackup.fill(0);intentBytes.fill(0);cuts.forEach(cut=>cut.bytes.fill(0));rotation.free();candidate.free();vault.free();store.close();db.close();
    return {account,id,documents,states,sources,rootNonce:Array.from(originalRoot.nonce),quotaRejected,sourceRejected,charged,vaultBlocked,journalBlocked,removeBlocked,livePreserved,tamperRejected,tamperPublishRejected,originalReadable,incompleteRejected,injected,failureRejected,failureAtomic,refunded,intentRoundtrip};
  });
  expect(saved).toMatchObject({quotaRejected:true,sourceRejected:true,charged:true,vaultBlocked:true,journalBlocked:true,removeBlocked:true,livePreserved:true,tamperRejected:true,tamperPublishRejected:true,originalReadable:true,incompleteRejected:true,injected:true,failureRejected:true,failureAtomic:true,refunded:true,intentRoundtrip:true});
  await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);await offlineServer.stop();await page.reload();
  const recovered=await page.evaluate(async saved=>{
    const wasmPath='/wasm/needware_wasm.js',storePath='/vault-store.js',journalPath='/sync-journal.js';
    const wasm=await import(wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import(storePath),{DurableSyncSession}=await import(journalPath),store=await openVaultStore();
    const pending=await store.rotations.load(saved.account),intent=JSON.parse(new TextDecoder().decode(pending.bytes));pending.bytes.fill(0);
    const decode=(value:string)=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
    const backup=decode(intent.backup),candidate=wasm.BrowserVault.from_local_backup(backup),old=await store.load(saved.account),oldVault=wasm.BrowserVault.from_local_backup(old.bytes);old.bytes.fill(0);
    const before=[];for(const document of saved.documents){const journal=await DurableSyncSession.open(store.documents,oldVault,saved.account,document,true);before.push(journal.snapshot());await journal.close();}
    const generation=await store.rotations.publish(saved.account,saved.id,backup,pending.generation,intent.cuts.map((cut:any)=>({...cut,bytes:decode(cut.bytes)})));backup.fill(0);
    const root=await store.load(saved.account),vault=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);
    const after=[],history=[];let staleRejected=false;try{await store.save(saved.account,oldVault.local_backup(),1);}catch{staleRejected=true;}
    for(const document of saved.documents){
      const journal=await DurableSyncSession.open(store.documents,vault,saved.account,document,true);after.push(journal.snapshot());await journal.close();
      const current=await store.documents.load(saved.account,document),parsed=JSON.parse(new TextDecoder().decode(current.bytes));current.bytes.fill(0);
      const archived=JSON.parse(parsed.archive[0]),binding=JSON.parse(archived.binding),historicalBackup=vault.local_backup(),historicalVault=wasm.BrowserVault.from_local_backup(historicalBackup);historicalBackup.fill(0);
      historicalVault.forget_document(document);historicalVault.restore_held_document_key(archived.held,JSON.stringify(binding.document));
      const historical=historicalVault.open_shared_document(decode(archived.package),document,archived.membership,archived.ownerEpoch,archived.authority,binding.generation,archived.scope,binding.schema_epoch,true);
      historical.set_roster(archived.roster);for(const frame of archived.frames)historical.receive(frame);historical.restore_local_state(archived.state);history.push(historical.snapshot());historical.free();historicalVault.free();
    }
    const noPending=(await store.rotations.load(saved.account))===undefined,context=JSON.parse(vault.account_context());store.close();candidate.free();oldVault.free();vault.free();
    return {generation,rootGeneration:root.generation,epoch:context.epoch,before,after,history,noPending,staleRejected};
  },saved);
  expect(recovered).toMatchObject({generation:2,rootGeneration:2,epoch:2,before:saved.states,after:saved.states,history:saved.states,noPending:true,staleRejected:true});
});
