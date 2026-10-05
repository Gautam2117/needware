import {test,expect} from './fixtures';
import {readFileSync} from 'node:fs';
import AxeBuilder from '@axe-core/playwright';

for(const kind of ['list','table'])test(`bounded native ${kind} pages retain row drafts, persist exact edits and survive cold reopen`,async({page})=>{
  test.setTimeout(120_000);
  await page.goto('/');await expect(page.getByText('Local runtime ready',{exact:true})).toBeVisible();
  const bytes=[...readFileSync(kind==='table'?'artifacts/controls/paging-table.need':'artifacts/controls/paging.need')];
  await page.evaluate(async bytes=>{
    const worker=new Worker('/runtime-worker.js',{type:'module'});let id=0;
    const pending=new Map<number,{resolve(value:any):void;reject(error:Error):void}>();
    worker.onmessage=event=>{const request=pending.get(event.data.id);if(!request)return;pending.delete(event.data.id);event.data.ok?request.resolve(event.data.data):request.reject(Error(event.data.error));};
    const request=(command:unknown)=>new Promise<any>((resolve,reject)=>{pending.set(++id,{resolve,reject});worker.postMessage({id,command});});
    try{const loaded=await request({kind:'load',bytes:new Uint8Array(bytes),consent:true});for(let index=0;index<251;index++)await request({kind:'dispatch',instance:loaded.instance,action:'add',values:{record_id:{type:'string',value:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`},name:{type:'string',value:`Record ${String(index).padStart(3,'0')}`}}});}finally{worker.terminate();}
  },bytes);
  await page.reload();await page.getByRole('button',{name:'Open Paged records fixture',exact:true}).click();
  const frame=page.frameLocator('iframe'),region=page.getByRole('region',{name:'Unsaved input recovery'});
  await expect(frame.getByRole('status')).toHaveText('Showing 1–100 of 251 records');
  const first=frame.getByLabel('Record name',{exact:true}).first();await first.fill('Unsaved first page');
  await frame.getByRole('button',{name:'Next page',exact:true}).click();await expect(frame.getByRole('status')).toHaveText('Showing 101–200 of 251 records');await expect(region.getByRole('status')).toContainText('1 unsaved input');
  await expect(frame.getByText('Record 100',{exact:true})).toBeVisible();await frame.getByRole('button',{name:'Next page',exact:true}).click();await expect(frame.getByRole('status')).toHaveText('Showing 201–251 of 251 records');await expect(frame.getByRole('button',{name:'Next page',exact:true})).toBeDisabled();await expect(frame.getByText('Record 250',{exact:true})).toBeVisible();
  await frame.getByRole('button',{name:'Previous page',exact:true}).click();await frame.getByRole('button',{name:'Previous page',exact:true}).click();await expect(first).toHaveValue('Unsaved first page');await expect(region.getByRole('status')).toContainText('1 unsaved input');
  await frame.getByRole('button',{name:'Save record',exact:true}).first().click();await expect(region.getByRole('status')).toContainText('0 unsaved inputs');await expect(frame.getByText('Unsaved first page',{exact:true})).toBeVisible();
  const audit=await new AxeBuilder({page}).include('iframe').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();expect(audit.violations).toEqual([]);
  await page.reload();await page.getByRole('button',{name:'Open Paged records fixture',exact:true}).click();await expect(first).toHaveValue('Unsaved first page');await expect(frame.getByRole('status')).toHaveText('Showing 1–100 of 251 records');
});

test('encrypted page projection emits no writes or uploads and keeps invalid cursors atomic',async({page})=>{
  test.setTimeout(120_000);await page.goto('/');const bytes=[...readFileSync('artifacts/controls/encrypted-paging.need')];
  const result=await page.evaluate(async bytes=>{
    const wasm=await import('/wasm/needware_wasm.js');await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});const {openVaultStore}=await import('/vault-store.js'),{DurableSyncSession}=await import('/sync-journal.js');
    const account=crypto.randomUUID(),vault=new wasm.BrowserVault(account),store=await openVaultStore(),scope=JSON.stringify({values:[],collections:['habits']}),original=vault.start_document(new Uint8Array(bytes),crypto.randomUUID(),scope,1,true),roster=JSON.stringify([JSON.parse(original.membership())]);
    const backup=vault.local_backup();await store.save(account,backup,null);backup.fill(0);
    const journal=await DurableSyncSession.create(store.documents,vault,new Uint8Array(bytes),original,{account,rootGeneration:1,scope,ownerEpoch:1,authority:vault.account_authority(),roster});
    for(let index=0;index<101;index++)await journal.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`},name:{type:'string',value:`Record ${index}`}},now:'2026-10-05T00:00:00Z',timezone:'UTC'}));
    const state=journal.snapshot(),queue=JSON.stringify(journal.pending());let writes=0;const save=store.documents.save;store.documents.save=async()=>{writes++;throw Error('No page write allowed');};
    try{const next=JSON.parse(await journal.selectPage('habits',100)),list=next.children.find((node:any)=>node.id==='habits');const stable=journal.view();let rejected=false;try{await journal.selectPage('habits',1);}catch{rejected=true;}return {offset:list.pagination.offset,rows:list.children.length,writes,unchanged:state===journal.snapshot()&&queue===JSON.stringify(journal.pending()),rejected,atomic:stable===journal.view()};}finally{store.documents.save=save;await journal.close();vault.free();store.close();}
  },bytes);expect(result).toEqual({offset:100,rows:1,writes:0,unchanged:true,rejected:true,atomic:true});
});
