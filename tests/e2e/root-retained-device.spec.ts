import { test, expect } from '@playwright/test';
test('an explicitly retained device accepts the new root against its own old pin without replacing its source',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const path='/wasm/needware_wasm.js',wasm=await import(path);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const owner=new wasm.BrowserVault(crypto.randomUUID()),kept=new wasm.BrowserVault(undefined),removed=new wasm.BrowserVault(undefined),bytes=wasm.authored_sync_example(),scope=JSON.stringify({values:[],collections:['habits']});
    for(const device of [kept,removed])device.accept_enrollment(owner.approve_device(device.device_public(),true),owner.account_context(),owner.account_authority());
    const original=owner.start_document(bytes,crypto.randomUUID(),scope,1,true),binding=original.binding(),document=JSON.parse(binding).document.document;
    original.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Preserved retained-device history'}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));
    const oldRoot=kept.account_context(),oldPin=kept.account_authority(),held=owner.held_document_key_backup(document);
    kept.restore_held_document_key(held,JSON.stringify(JSON.parse(binding).document));removed.restore_held_document_key(held,JSON.stringify(JSON.parse(binding).document));
    const rotation=owner.prepare_root_rotation(true),next=rotation.preview(),epoch=next.prepare_root_document_epoch(original,rotation.proof(),true),checkpoint=epoch.checkpoint(),current=epoch.publish(next);
    const approval=next.approve_device(kept.device_public(),true),proof=rotation.proof(),pin=next.account_authority(),context=next.account_context();
    let ordinaryRejected=false;try{kept.accept_enrollment(approval,context,pin);}catch{ordinaryRejected=true;}
    let wrongRecipientRejected=false;try{removed.accept_root_rotation(proof,approval,context,pin);}catch{wrongRecipientRejected=true;}
    let stalePinRejected=false;try{kept.accept_root_rotation(proof,approval,oldRoot,oldPin);}catch{stalePinRejected=true;}
    const altered=JSON.parse(proof);altered.acceptance[0]^=1;let tamperRejected=false;try{kept.accept_root_rotation(JSON.stringify(altered),approval,context,pin);}catch{tamperRejected=true;}
    const alteredApproval=JSON.parse(approval);alteredApproval.envelope.ciphertext[0]^=1;let hpkeTamperRejected=false;try{kept.accept_root_rotation(proof,JSON.stringify(alteredApproval),context,pin);}catch{hpkeTamperRejected=true;}
    const acceptance=kept.accept_root_rotation(proof,approval,context,pin),candidate=acceptance.preview();
    const sourcePreserved=kept.account_context()===oldRoot&&removed.account_context()===oldRoot;
    const historical=acceptance.rewrap_held_backup(held,JSON.stringify(JSON.parse(binding).document));
    candidate.forget_document(document);candidate.restore_held_document_key(historical,JSON.stringify(JSON.parse(binding).document));
    const originalCipher=original.seal_payload(new Uint8Array([7,8]),'historical root');
    const oldHistoryRecovered=Array.from(candidate.open_document_payload(document,originalCipher,'historical root')).join(',')==='7,8';
    candidate.forget_document(document);candidate.restore_held_document_key(next.held_document_key_backup(document),JSON.stringify(JSON.parse(current.binding()).document));
    const membership=candidate.own_document_membership(document,2),session=candidate.open_shared_document(bytes,document,membership,2,pin,2,scope,1,true);
    session.set_roster(JSON.stringify([JSON.parse(current.membership()),JSON.parse(membership)]));session.install_accepted_root_epoch(checkpoint,binding);
    const currentHistoryRecovered=session.snapshot()===original.snapshot(),cipher=current.seal_payload(new Uint8Array([9]),'current root');
    let oldKeyRejected=false;try{removed.open_document_payload(document,cipher,'current root');}catch{oldKeyRejected=true;}
    const backup=candidate.local_backup(),cold=wasm.BrowserVault.from_local_backup(backup);backup.fill(0);
    const coldRootRecovered=cold.account_context()===context&&Array.from(cold.open_document_payload(document,cipher,'current root')).join(',')==='9';
    for(const handle of [cold,session,candidate,acceptance,current,epoch,next,rotation,original,owner,kept,removed])handle.free();checkpoint.fill(0);
    return {ordinaryRejected,wrongRecipientRejected,stalePinRejected,tamperRejected,hpkeTamperRejected,sourcePreserved,oldHistoryRecovered,currentHistoryRecovered,oldKeyRejected,coldRootRecovered};
  });
  expect(result).toEqual({ordinaryRejected:true,wrongRecipientRejected:true,stalePinRejected:true,tamperRejected:true,hpkeTamperRejected:true,sourcePreserved:true,oldHistoryRecovered:true,currentHistoryRecovered:true,oldKeyRejected:true,coldRootRecovered:true});
});
