'use client';
import {useState} from 'react';
export type DraftStatus={count:number;pending:number;ready?:boolean};
export type DraftRequest=(operation:'status'|'export'|'import'|'preview',value?:unknown)=>Promise<unknown>;
export type SandboxHandle={confirmLeave():Promise<boolean>;navigate(href:string):Promise<boolean>};
export function validDraftStatus(value:unknown):value is DraftStatus{if(!value||typeof value!=='object')return false;const status=value as DraftStatus;return Number.isInteger(status.count)&&status.count>=0&&status.count<=4096&&Number.isInteger(status.pending)&&status.pending>=0&&status.pending<=32;}
export function DraftRecovery({status,request,binding,digest,error,ready}:{ready:boolean;status:DraftStatus;request:DraftRequest;binding:string;digest:string;error(message:string):void}){
  const [busy,setBusy]=useState(false);
  const [recovery,setRecovery]=useState<{binding:string;digest:string;drafts:unknown[]}>();
  const remaining=recovery?.binding===binding&&recovery.digest===digest?recovery:undefined;
  async function available(drafts:unknown[]){const value=await request('preview',drafts);if(!Array.isArray(value)||value.length>4096||new Set(value).size!==value.length||!value.every(index=>Number.isInteger(index)&&index>=0&&index<drafts.length))throw Error('Invalid recovery preview.');return value as number[];}
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
    if(!Array.isArray(value.drafts))throw Error('Invalid draft recovery.');const indices=await available(value.drafts);
    if(indices.length===value.drafts.length){await request('import',value.drafts);setRecovery(undefined);}
    else {setRecovery({binding,digest,drafts:value.drafts});throw Error('Recovery field is unavailable. Open its original application screen, then explicitly recover the available inputs. No inputs were imported. Keep the original recovery file for other screens.');}
  }
  async function recoverScreen(){
    if(!remaining)throw Error('Recovery belongs to another application or signed revision.');const indices=await available(remaining.drafts);if(!indices.length)throw Error('No recovery inputs are available on this screen. Open their original screen first.');
    if(!window.confirm(`Recover ${indices.length} inputs on this screen for explicit review? ${remaining.drafts.length-indices.length} other inputs remain in your original recovery file. Saved data stays unchanged until you submit.`))return;
    await request('import',indices.map(index=>remaining.drafts[index]));const selected=new Set(indices),drafts=remaining.drafts.filter((_,index)=>!selected.has(index));setRecovery(drafts.length?{binding,digest,drafts}:undefined);
  }
  return <section aria-label="Unsaved input recovery"><p role="status">{status.count} unsaved {status.count===1?'input':'inputs'}{status.pending?` · ${status.pending} pending changes`:''}. Unsaved inputs stay in this page until saved. Export them before closing if you need recovery.</p><div className="toolbar"><button disabled={!ready||busy||!status.count||Boolean(status.pending)} onClick={()=>void run(exportFile)}>Export plaintext unsaved inputs</button><label className="file-label">Recover unsaved inputs<input type="file" accept=".json,application/json" disabled={!ready||busy||Boolean(status.pending)} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void run(()=>importFile(file));}} /></label></div>{remaining&&<div className="notice"><p>{remaining.drafts.length} inputs remain to recover. Keep the original recovery file. Open each original screen, recover its available inputs, review and save them before recovering another screen.</p><button disabled={!ready||busy||Boolean(status.count)||Boolean(status.pending)} onClick={()=>void run(recoverScreen)}>Recover inputs on this screen</button><button disabled={busy} onClick={()=>setRecovery(undefined)}>Close recovery preview</button></div>}</section>;
}
