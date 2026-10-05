'use client';
import {useEffect,useRef,useState} from 'react';
import type {DraftSnapshot,DraftSummary} from '../../../packages/browser-host/src/draft-journal';
import type {DraftRequest,DraftStatus} from './draft-recovery';
export interface DurableDrafts {
  save(id:string,fields:unknown):Promise<void>;
  summaries():Promise<DraftSummary[]>;
  load(summary:DraftSummary):Promise<DraftSnapshot>;
  forget(summary:DraftSummary):Promise<void>;
}
export function EncryptedDraftRecovery({durable,status,request,ready,binding,digest,recover,error}:{durable:DurableDrafts;status:DraftStatus;request:DraftRequest;ready:boolean;binding:string;digest:string;recover(fields:unknown[]):Promise<void>;error(message:string):void}){
  const [writer]=useState(()=>crypto.randomUUID());const started=useRef(false),alive=useRef(true),tail=useRef<Promise<void>>(Promise.resolve());
  const latest=useRef({durable,status,request,recover,error});
  useEffect(()=>{latest.current={durable,status,request,recover,error};},[durable,status,request,recover,error]);
  const [message,setMessage]=useState('No new edits saved yet. Earlier encrypted recoveries remain available.');const [records,setRecords]=useState<DraftSummary[]>([]),[busy,setBusy]=useState(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function refresh(){const records=await latest.current.durable.summaries();if(alive.current)setRecords(records);}
  useEffect(()=>{if(ready)void refresh().catch(failure=>latest.current.error(String(failure)));},[ready]);
  useEffect(()=>{
    if(!ready||status.pending)return;
    if(status.version===undefined)return;
    if(status.count)started.current=true;if(!started.current)return;
    setMessage('Saving encrypted recovery…');const version=status.version;
    const timer=setTimeout(()=>{tail.current=tail.current.catch(()=>{}).then(async()=>{
      if(!alive.current)return;const fields=await latest.current.request('export');await latest.current.durable.save(writer,fields);
      if(alive.current&&latest.current.status.version===version)setMessage('Encrypted recovery saved on this browser. Application data stays unchanged until you submit.');
      await refresh();
    }).catch(failure=>{if(alive.current){setMessage('Encrypted recovery could not be saved. Keep this page open and export your inputs.');latest.current.error(String(failure));}});},500);
    return()=>clearTimeout(timer);
  },[ready,status.count,status.pending,status.version,writer]);
  async function run(operation:()=>Promise<void>){setBusy(true);try{await operation();}catch(failure){latest.current.error(String(failure));}finally{if(alive.current)setBusy(false);}}
  async function exported(summary:DraftSummary){
    if(!window.confirm('Export this encrypted recovery as a plaintext file? It may contain private inputs. Keep it private.'))return;
    const snapshot=await latest.current.durable.load(summary),file=JSON.stringify({format:'needware-drafts-v1',binding,digest:snapshot.digest,drafts:snapshot.fields});
    const url=URL.createObjectURL(new Blob([file],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='needware-encrypted-draft-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <section aria-label="Encrypted draft recovery"><h3>Encrypted draft recovery</h3><p role="status">{ready&&status.version===undefined?"Encrypted recovery requires the current runtime. Export inputs before closing and reopen after updating.":message}</p><p>Recovery stays on this browser, encrypted with your local document journal. It is not uploaded to collaborators. Wait for the saved confirmation before closing. Storage removal can delete recovery.</p><button type="button" disabled={!ready||busy} onClick={()=>void run(refresh)}>Refresh encrypted recoveries</button>{records.length>0&&<ul>{records.map(record=><li key={`${record.source}:${record.id}:${record.generation}`}><p>{record.count} inputs · {record.digest===digest?'This signed revision':'Earlier signed revision'}{record.source?' · Retained history':''}</p><button type="button" disabled={!ready||busy||Boolean(status.count)||Boolean(status.pending)||record.digest!==digest} onClick={()=>void run(async()=>{const snapshot=await latest.current.durable.load(record);if(snapshot.digest!==digest)throw Error('Recovery belongs to an earlier signed revision. Export it and open that revision for review.');await latest.current.recover(snapshot.fields);})}>Review encrypted recovery</button><button type="button" disabled={!ready||busy} onClick={()=>void run(()=>exported(record))}>Export plaintext recovery</button>{record.source===0&&<button type="button" disabled={!ready||busy||Boolean(status.count)||Boolean(status.pending)} onClick={()=>void run(async()=>{if(!window.confirm('Permanently remove this local draft recovery? Export it first if you need it. Saved records stay unchanged.'))return;await latest.current.durable.forget(record);await refresh();})}>Remove saved recovery</button>}</li>)}</ul>}</section>;
}
