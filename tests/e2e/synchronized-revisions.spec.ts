import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
test('reviewed synchronized schema cut retains stale work and requires fresh keys and explicit installation',async({page})=>{
  const source=Array.from(await readFile('artifacts/revisions/sync-source.need'));
  const target=Array.from(await readFile('artifacts/revisions/sync-target.need'));
  await page.goto('/');
  const result=await page.evaluate(async({source,target})=>{
    const path='/wasm/needware_wasm.js',wasm=await import(/* webpackIgnore: true */path);
    await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const vault=new wasm.BrowserVault(crypto.randomUUID()),scope=JSON.stringify({values:[],collections:['habits']});
    const original=vault.start_document(new Uint8Array(source),crypto.randomUUID(),scope,1,true);
    const add=(name:string)=>original.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:name}},now:'2026-10-05T00:00:00Z',timezone:'UTC'}));
    add('Original source');const review=original.review_revision(new Uint8Array(target),scope),info=JSON.parse(review.info());
    let consent=false,destructive=false,wrongDigest=false,stale=false;
    try{vault.prepare_revision_document_epoch(original,review,info.review_digest,false,true);}catch{consent=true;}
    try{vault.prepare_revision_document_epoch(original,review,info.review_digest,true,false);}catch{destructive=true;}
    try{vault.prepare_revision_document_epoch(original,review,'00'.repeat(32),true,true);}catch{wrongDigest=true;}
    add('Preserved offline edit');const before=original.snapshot(),binding=original.binding();
    try{vault.prepare_revision_document_epoch(original,review,info.review_digest,true,true);}catch{stale=true;}
    const fresh=original.review_revision(new Uint8Array(target),scope),digest=JSON.parse(fresh.info()).review_digest;
    const epoch=vault.prepare_revision_document_epoch(original,fresh,digest,true,true);
    const unchanged=original.snapshot()===before&&original.binding()===binding;
    const peer=new wasm.BrowserVault(undefined);peer.accept_enrollment(vault.approve_device(peer.device_public(),true),vault.account_context(),vault.account_authority());
    const offer=epoch.offer_document(vault,peer.device_certificate(),peer.account_context(),peer.account_authority(),false,true);
    const checkpoint=epoch.checkpoint(),current=epoch.publish(vault),next=JSON.parse(current.binding());
    const receiver=peer.join_document(new Uint8Array(target),offer,JSON.stringify(next.document),1,vault.account_authority(),2,scope,2,true);
    receiver.set_roster(JSON.stringify([JSON.parse(current.membership()),JSON.parse(receiver.membership())]));
    let ordinary=false,oldKey=false;
    try{receiver.install_epoch(checkpoint,binding);}catch{ordinary=true;}
    receiver.install_revision_epoch(checkpoint,binding);
    const cipher=current.seal_payload(new Uint8Array([7]),'revision fresh key');try{original.open_payload(cipher,'revision fresh key');}catch{oldKey=true;}
    const converged=receiver.snapshot()===current.snapshot(),state=JSON.parse(current.snapshot());
    for(const value of [receiver,current,peer,epoch,fresh,review,original,vault])value.free();
    return {consent,destructive,wrongDigest,stale,unchanged,ordinary,oldKey,converged,schema:next.schema_epoch,state};
  },{source,target});
  for(const key of ['consent','destructive','wrongDigest','stale','unchanged','ordinary','oldKey','converged'] as const)expect(result[key],key).toBe(true);
  expect(result.schema).toBe(2);expect(Object.values(result.state.collections.habits)).toHaveLength(2);
  for(const row of Object.values(result.state.collections.habits) as Record<string,unknown>[]){expect(row.score).toBeUndefined();expect(row.note).toEqual({type:'string',value:'Reviewed'});}
});
