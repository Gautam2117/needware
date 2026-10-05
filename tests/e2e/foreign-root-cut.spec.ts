import {test,expect} from '@playwright/test';
test('holder root publication preserves foreign authority, original offline frames and encrypted state',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const wasm=await import('/wasm/needware_wasm.js');await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import('/vault-store.js'),{DurableSyncSession}=await import('/sync-journal.js');
    const owner=new wasm.BrowserVault(crypto.randomUUID()),holder=new wasm.BrowserVault(crypto.randomUUID()),account=JSON.parse(holder.account_context()).account,store=await openVaultStore(),bytes=wasm.authored_sync_example(),scope=JSON.stringify({values:[],collections:['habits']});
    const backup=holder.local_backup();await store.save(account,backup,null);backup.fill(0);
    const source=owner.start_document(bytes,crypto.randomUUID(),scope,1,true),document=JSON.parse(source.binding()).document.document,offer=owner.offer_document(document,holder.device_certificate(),holder.account_context(),holder.account_authority(),true,true);
    const peer=holder.join_document(bytes,offer,JSON.stringify(JSON.parse(source.binding()).document),1,owner.account_authority(),1,scope,1,true),roster=JSON.stringify([JSON.parse(source.membership()),JSON.parse(peer.membership())]);peer.set_roster(roster);
    const root=await store.load(account);root.bytes.fill(0);
    const journal=await DurableSyncSession.create(store.documents,holder,bytes,peer,{account,rootGeneration:root.generation,scope,ownerEpoch:1,authority:owner.account_authority(),roster});
    await journal.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Original offline foreign work'}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));
    const before=journal.snapshot(),pending=JSON.stringify(journal.pending()),binding=journal.binding(),rotation=holder.prepare_root_rotation(true),candidate=rotation.preview(),cut=await journal.prepareForeignRootCut(candidate,rotation,true),saved=await store.load(account);saved.bytes.fill(0);
    const intent=new TextEncoder().encode('authenticated foreign root cut'),id=crypto.randomUUID();await store.rotations.stage(account,id,intent,saved.generation,[{document,generation:cut.generation}]);
    const next=candidate.local_backup();await store.rotations.publish(account,id,next,saved.generation,[cut]);next.fill(0);cut.bytes.fill(0);intent.fill(0);await journal.close();
    const coldBackup=await store.load(account),cold=wasm.BrowserVault.from_local_backup(coldBackup.bytes);coldBackup.bytes.fill(0);
    const reopened=await DurableSyncSession.open(store.documents,cold,account,document,true),actual={state:reopened.snapshot()===before,queued:JSON.stringify(reopened.pending())===pending,binding:reopened.binding()===binding,holderEpoch:JSON.parse(cold.account_context()).epoch,ownerEpoch:JSON.parse(owner.account_context()).epoch};
    await reopened.close();for(const value of [cold,candidate,rotation,holder,owner,source])value.free();store.close();return actual;
  });expect(result).toEqual({state:true,queued:true,binding:true,holderEpoch:2,ownerEpoch:1});
});
