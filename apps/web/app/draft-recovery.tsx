'use client';
import {useState} from 'react';
export type DraftStatus={count:number;pending:number;ready?:boolean};
export type DraftRequest=(operation:'status'|'export'|'import',value?:unknown)=>Promise<unknown>;
export type SandboxHandle={confirmLeave():Promise<boolean>};
export function validDraftStatus(value:unknown):value is DraftStatus{if(!value||typeof value!=='object')return false;const status=value as DraftStatus;return Number.isInteger(status.count)&&status.count>=0&&status.count<=4096&&Number.isInteger(status.pending)&&status.pending>=0&&status.pending<=32;}
export function DraftRecovery({status,request,binding,digest,error,ready}:{ready:boolean;status:DraftStatus;request:DraftRequest;binding:string;digest:string;error(message:string):void}){
  const [busy,setBusy]=useState(false);
  async function run(operation:()=>Promise<void>){setBusy(true);try{await operation();}catch(failure){error(String(failure));}finally{setBusy(false);}}
  async function exportFile(){
    if(!window.confirm('Export unsaved inputs as a plaintext recovery file? It can contain private information. Keep it private; imported inputs require review before saving.'))return;
    const drafts=await request('export');const file=JSON.stringify({format:'needware-drafts-v1',binding,digest,drafts});
    const url=URL.createObjectURL(new Blob([file],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='needware-unsaved-drafts.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function importFile(file:File){
    if(file.size>8*1024*1024)throw Error('Draft recovery file exceeds 8 MiB.');const value=JSON.parse(await file.text());
    if(value?.format!=='needware-drafts-v1'||value.binding!==binding||value.digest!==digest)throw Error('Draft recovery belongs to a different application, document, or signed revision.');
    if(!window.confirm('Recover these unsaved inputs for explicit review? Saved application data will stay unchanged until you review and submit each form.'))return;
    await request('import',value.drafts);
  }
  return <section aria-label="Unsaved input recovery"><p role="status">{status.count} unsaved {status.count===1?'input':'inputs'}{status.pending?` · ${status.pending} pending changes`:''}. Unsaved inputs stay in this page until saved. Export them before closing if you need recovery.</p><div className="toolbar"><button disabled={!ready||busy||!status.count||Boolean(status.pending)} onClick={()=>void run(exportFile)}>Export plaintext unsaved inputs</button><label className="file-label">Recover unsaved inputs<input type="file" accept=".json,application/json" disabled={!ready||busy||Boolean(status.pending)} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void run(()=>importFile(file));}} /></label></div></section>;
}
