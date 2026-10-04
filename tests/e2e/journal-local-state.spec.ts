import {test,expect} from './fixtures';
test('encrypted journal restores a device-local snapshot beyond the small vault-message limit',async({page,offlineServer})=>{
  test.setTimeout(90_000);
  await page.goto(offlineServer.url);
  const saved=await page.evaluate(async()=>{
    const wasmPath='/wasm/needware_wasm.js',storePath='/vault-store.js',journalPath='/sync-journal.js';
    const wasm=await import(/* webpackIgnore: true */ wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import(/* webpackIgnore: true */ storePath),{DurableSyncSession}=await import(/* webpackIgnore: true */ journalPath);
    const account=crypto.randomUUID();const vault=new wasm.BrowserVault(account);const store=await openVaultStore();const backup=vault.local_backup();await store.save(account,backup,null);backup.fill(0);
    const bytes=wasm.authored_example();const scope=JSON.stringify({values:[],collections:[]});const original=vault.start_document(bytes,crypto.randomUUID(),scope,1,true);
    const document=JSON.parse(original.binding()).document.document;
    const journal=await DurableSyncSession.create(store.documents,vault,bytes,original,{account,rootGeneration:1,scope,ownerEpoch:1,authority:vault.account_authority(),roster:JSON.stringify([JSON.parse(original.membership())])});
    for(let i=0;i<220;i++)await journal.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:`${i}:`+'x'.repeat(65)}},now:'2026-10-04T00:00:00Z',timezone:'UTC'}));
    const state=journal.snapshot();const pending=journal.pending().length;await journal.close();vault.free();store.close();return {account,document,state,pending};
  });
  expect(saved.state.length).toBeGreaterThan(32768);expect(saved.pending).toBe(0);
  await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);await offlineServer.stop();await page.reload();
  const reopened=await page.evaluate(async saved=>{
    const wasmPath='/wasm/needware_wasm.js',storePath='/vault-store.js',journalPath='/sync-journal.js';
    const wasm=await import(/* webpackIgnore: true */ wasmPath);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const {openVaultStore}=await import(/* webpackIgnore: true */ storePath),{DurableSyncSession}=await import(/* webpackIgnore: true */ journalPath);
    const store=await openVaultStore();const root=await store.load(saved.account);const vault=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);
    const journal=await DurableSyncSession.open(store.documents,vault,saved.account,saved.document,true);const state=journal.snapshot();await journal.close();vault.free();store.close();return state;
  },saved);expect(reopened).toBe(saved.state);
});
