'use client';
import {useCallback,useEffect,useImperativeHandle,useRef,useState,type Ref} from 'react';
import type {EffectIntent} from '../../../packages/browser-host/src/effect-journal';
import type {EffectOutcome} from '@needware/ir-types/EffectOutcome';
import type {ViewNode} from '@needware/ir-types/ViewNode';
type Review=EffectIntent & {stale:boolean};
export interface EffectReviewHandle {confirmLeave():boolean}
export type EffectBroker=(kind:'effect-review'|'begin-effect'|'record-effect'|'finish-effect'|'discard-effect',id?:string,outcome?:EffectOutcome)=>Promise<unknown>;
export default function EffectReview({broker,view,completed,ref}:{ref?:Ref<EffectReviewHandle>;broker:EffectBroker;view:ViewNode;completed:(result:{view:ViewNode;pendingUploads:number})=>void}) {
  const [effect,setEffect]=useState<Review|null>(null),[authorized,setAuthorized]=useState<string>(),[known,setKnown]=useState<EffectOutcome>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const occupied=useRef(false);
  useImperativeHandle(ref,()=>({confirmLeave(){if(occupied.current){setError('Finish external result recovery before changing applications.');return false;}return !known||Boolean(effect?.outcome)||window.confirm('The returned external result is only retained on this page. Save or export it before leaving. Leave and lose this unrecorded result?');}}),[known,effect?.outcome]);
  useEffect(()=>{if(!busy&&(!known||effect?.outcome))return;const leave=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[busy,known,effect?.outcome]);

  const refresh=useCallback(async()=>{const value=await broker('effect-review') as Review|null;setEffect(value);return value;},[broker]);
  useEffect(()=>{let active=true;void broker('effect-review').then(value=>{if(active)setEffect(value as Review|null);}).catch(failure=>{if(active)setError((failure as Error).message);});return()=>{active=false;};},[broker,view]);
  async function run(action:()=>Promise<void>){if(occupied.current)return;occupied.current=true;setBusy(true);setError('');try{await action();}catch(failure){setError((failure as Error).message);}finally{occupied.current=false;setBusy(false);}}
  async function settle(outcome?:EffectOutcome){
    const current=await refresh();if(!current||current.id!==effect?.id)throw Error('Effect review changed. Reopen the application to inspect its saved state.');
    if(current.status==='dispatching'){if(!outcome)throw Error('The external outcome is unknown. It cannot be replayed.');await broker('record-effect',current.id,outcome);}
    const result=await broker('finish-effect',current.id) as {view:ViewNode;pendingUploads:number};completed(result);setKnown(undefined);setAuthorized(undefined);await refresh();
  }
  if(!effect)return error?<p role="alert">{error}</p>:null;
  const retainedOutcome=effect.outcome??known;
  const input=effect.request.input,clipboard=effect.request.capability.kind==='clipboard'&&!effect.request.capability.read&&input.type==='string'&&input.value.length<=65536&&effect.request.flow?.output.data_type.type==='string';
  return <section aria-label="External action review"><h3>Review external action</h3><p>This action can expose application text outside Needware. Your signed application requested {effect.request.capability.kind} access.</p>
    {input.type==='string'&&<label>{clipboard?'Clipboard content':'Retained action content'}<textarea readOnly value={input.value} /></label>}
    {retainedOutcome&&<label>Retained external result<textarea readOnly value={JSON.stringify(retainedOutcome)} /></label>}
    {effect.stale?<p role="status">The document changed. This retained request or result needs review and cannot change the newer state.</p>:effect.status==='prepared'?<p role="status">The request is saved. Review its content before authorizing an external action.</p>:effect.status==='result'?<p role="status">The external result is saved. Apply it once to the unchanged document.</p>:known?<p role="status">The external result is retained on this page. Save or export it before leaving. Do not repeat the external action.</p>:authorized===effect.id?<p role="status">Authorized for this open page. Use Copy reviewed text to write to your clipboard.</p>:<p role="status">The external outcome is unknown. This action cannot be replayed.</p>}
    {clipboard&&!effect.stale&&effect.status==='prepared'&&<button disabled={busy} onClick={()=>void run(async()=>{const started=await broker('begin-effect',effect.id) as EffectIntent;setAuthorized(started.id);await refresh();})}>Authorize clipboard write</button>}
    {clipboard&&!effect.stale&&effect.status==='dispatching'&&authorized===effect.id&&!known&&<button disabled={busy} onClick={()=>{
      if(occupied.current||input.type!=='string')return;
      // Invoke the browser API during this fresh trusted-shell click, before any awaited journal work.
      let operation:Promise<void>;try{operation=navigator.clipboard?navigator.clipboard.writeText(input.value):Promise.reject(Error('Clipboard unavailable'));}catch(failure){operation=Promise.reject(failure);}
      setAuthorized(undefined);void run(async()=>{let outcome:EffectOutcome;try{await operation;outcome={status:'success',value:{type:'string',value:input.value}};}catch{outcome={status:'failure',code:'clipboard_denied'};}setKnown(outcome);await settle(outcome);});
    }}>Copy reviewed text</button>}
    {!effect.stale&&(effect.status==='result'||known)&&<button disabled={busy} onClick={()=>void run(()=>settle(known))}>{known&&!effect.outcome?'Save and apply retained result':'Apply saved result'}</button>}
    <button disabled={busy} onClick={()=>{if(!window.confirm('Export this retained request and outcome as a plaintext file? Keep it private.'))return;const checkpoint=JSON.parse(effect.checkpoint),bytes=JSON.stringify({version:1,package:checkpoint.package,scope:checkpoint.scope,cut:checkpoint.records[0].cut,request:effect.request,status:effect.status,...(retainedOutcome?{outcome:retainedOutcome}:{})}),url=URL.createObjectURL(new Blob([bytes],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='needware-retained-action.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>Export plaintext retained action</button>
    <button disabled={busy} onClick={()=>void run(async()=>{if(!window.confirm('Remove this retained request and outcome? This cannot undo an external action already performed.'))return;await broker('discard-effect',effect.id);setAuthorized(undefined);setKnown(undefined);await refresh();})}>Remove retained action</button>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
