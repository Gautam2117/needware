import React,{useState,useEffect} from 'react';
import { createRoot } from 'react-dom/client';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { Value } from '@needware/ir-types/Value';
import { supported } from '../../renderer/src/registry';
import {RuntimeDialog} from './dialog';
import {RuntimeInput} from './input';
import {valuesFor,subscribe,dirtyCount,captureDrafts,acknowledgeDrafts,exportDrafts,importDrafts,previewDrafts,indexDraftFields} from './bindings';
import {RuntimeImage,RuntimeIcon,RuntimeTable,RuntimeTabs,RuntimeChart,RuntimeCalendar} from './visuals';

let channel: MessagePort | undefined;
let report=(message:string)=>{void message;};
let currentView:ViewNode|undefined;
const pending=new Map<string,ReturnType<typeof captureDrafts>>();
const pendingListeners=new Set<()=>void>();
const draftStatus=()=>{for(const listener of pendingListeners)listener();channel?.postMessage({kind:'needware-draft-status',count:dirtyCount(),pending:pending.size,ready:Boolean(currentView)});};
subscribe(draftStatus);
function fire(node: ViewNode) {
  if (!node.action||node.disabled) return;
  let values:Record<string,Value>;try{values={...valuesFor(node),record_id:{type:'string',value:node.record??crypto.randomUUID()}};report('');}catch(error){report(String(error));return;}
  const scoped = node.event_fields ? Object.fromEntries(Object.entries(values).filter(([key]) => node.event_fields!.includes(key))) : values;
  if(!channel||pending.size>=32){report('Wait for your pending application changes before submitting again.');return;}
  const request=crypto.randomUUID();pending.set(request,captureDrafts(node));draftStatus();channel.postMessage({ action: node.action, values: scoped,request });
}
function Node({ node }: { node: ViewNode }) {
  if(!node.open)return null;
  return <div className={`runtime-node tone-${node.style.tone} size-${node.style.size}`}><Body node={node}/>{node.pagination&&<Pager node={node}/>}</div>;
}
function Pager({node}:{node:ViewNode}){
  const [busy,setBusy]=useState(false);
  useEffect(()=>{const done=()=>setBusy(pending.size>0);pendingListeners.add(done);done();return()=>{pendingListeners.delete(done);};},[]);
  const page=node.pagination;if(!page||page.total<=page.limit)return null;
  function select(offset:number){
    if(!channel||pending.size){report('Wait for pending application changes before changing pages.');return;}
    const request=crypto.randomUUID();pending.set(request,[]);setBusy(true);draftStatus();
    channel.postMessage({kind:'needware-page',node:node.id,offset,request});
  }
  return <nav aria-label={`${node.text||'Collection'} pages`}><p role="status">Showing {page.offset+1}–{Math.min(page.total,page.offset+page.limit)} of {page.total} records</p><button type="button" disabled={node.disabled||busy||page.offset===0} onClick={()=>select(page.offset-page.limit)}>Previous page</button><button type="button" disabled={node.disabled||busy||page.offset+page.limit>=page.total} onClick={()=>select(page.offset+page.limit)}>Next page</button></nav>;
}
function Body({node}:{node:ViewNode}){
  const children = node.children.map(child => <Node key={child.id} node={child} />);
  switch (node.kind) {
    case 'heading': return <h2>{node.text}</h2>;
    case 'text': return <p>{node.text}</p>;
    case 'button': return <button type="button" disabled={node.disabled} onClick={event=>{event.currentTarget.focus();fire(node);}}>{node.text}</button>;
    case 'icon': return node.action?<button type="button" disabled={node.disabled} aria-label={node.text} onClick={()=>fire(node)}><RuntimeIcon node={node}/></button>:<RuntimeIcon node={node}/>;
    case 'image': return node.action?<button type="button" disabled={node.disabled} onClick={()=>fire(node)}><RuntimeImage node={node}/></button>:<RuntimeImage node={node}/>;
    case 'table': return <RuntimeTable node={node} render={child=><Node key={child.id} node={child}/>}/>;
    case 'tabs': return <RuntimeTabs node={node} render={child=><Node key={child.id} node={child}/>}/>;
    case 'chart': return <RuntimeChart node={node}/>;
    case 'calendar': return <RuntimeCalendar node={node}/>;
    case 'modal': case 'drawer': return <RuntimeDialog node={node} close={()=>fire(node)}>{children}</RuntimeDialog>;
    case 'divider': return <hr />;
    case 'spacer': return <div className="spacer" aria-hidden="true" />;
    case 'text_input': case 'numeric_input': case 'date_input': case 'datetime_input': case 'textarea': case 'checkbox': case 'toggle': case 'radio': case 'select': case 'multi_select': case 'slider': return <RuntimeInput node={node}/>;
    case 'form': return <form noValidate aria-label={node.text||'Application form'} onSubmit={event=>event.preventDefault()} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&event.target instanceof HTMLInputElement&&!['checkbox','radio'].includes(event.target.type)){event.preventDefault();fire(node);}}}><fieldset disabled={node.disabled}><legend>{node.text}</legend>{children}<button type="button" onClick={()=>fire(node)}>{node.text||'Save'}</button></fieldset></form>;
    case 'progress': return node.value?.type==='integer'?<label>{node.text}<progress max={100} value={Number(node.value.value)}/><output>{node.value.value}%</output></label>:<p role="alert">Progress has an invalid binding.</p>;
    case 'list': return children.length ? <div className="list">{children}</div> : <p className="empty">Nothing here yet. Add your first item.</p>;
    case 'row': return <div className="row">{children}</div>;
    case 'grid': return <div className="grid">{children}</div>;
    case 'card': return <section className="card">{children}</section>;
    case 'alert': return <p role="alert">{node.text}</p>;
    case 'badge': case 'stat': return <strong>{node.text}</strong>;
    default: return <div>{node.text}{children}</div>;
  }
}
function RuntimeView({node}:{node:ViewNode}){const [error,setError]=useState('');useEffect(()=>{report=setError;return()=>{report=()=>{};};},[]);return <div className="runtime-app" data-accent={node.theme?.accent??'teal'} data-density={node.theme?.density??'comfortable'} data-radius={node.theme?.radius??'rounded'}>{error&&<p role="alert">{error}</p>}<Node node={node}/></div>;}
function validView(node: ViewNode, count: { value: number }, depth = 0): boolean {
  if (!node || typeof node.id !== 'string' || typeof node.text !== 'string' || typeof node.open!=='boolean'||typeof node.disabled!=='boolean'||typeof node.active_overlay!=='boolean'|| !Array.isArray(node.children) || !supported.has(node.kind) || depth > 32 || ++count.value > 4096) return false;
  if(node.pagination){const p=node.pagination;if(!['list','table'].includes(node.kind)||p.limit!==100||!Number.isSafeInteger(p.offset)||!Number.isSafeInteger(p.total)||p.total<0||p.offset<0||p.offset%100!==0||(p.total===0?p.offset!==0:p.offset>=p.total))return false;}
  return node.children.every(child => validView(child, count, depth + 1));
}
const element = document.getElementById('root');
if (!element) throw new Error('Missing trusted renderer root');
const root = createRoot(element);
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.kind !== 'needware-connect' || !event.ports[0] || channel) return;
  channel = event.ports[0];
  channel.onmessage = event => {
    const message=event.data;
    if(message?.kind==='needware-action-result'){const captured=pending.get(message.request);if(!captured)return;pending.delete(message.request);if(message.ok===true)acknowledgeDrafts(captured);draftStatus();return;}
    if(message?.kind==='needware-draft-request'){
      if(typeof message.request!=='string'||message.request.length>64)return;
      try{let value:unknown;if(message.operation==='status')value={count:dirtyCount(),pending:pending.size};else if(message.operation==='export')value=exportDrafts();else if(message.operation==='preview'&&currentView)value=previewDrafts(message.value,currentView);else if(message.operation==='import'&&currentView){if(pending.size)throw Error('Wait for pending changes before recovering drafts.');importDrafts(message.value,currentView);value=true;}else throw Error('Unsupported draft operation.');channel?.postMessage({kind:'needware-draft-reply',request:message.request,ok:true,value});}catch(error){channel?.postMessage({kind:'needware-draft-reply',request:message.request,ok:false,error:String(error)});}return;
    }
    const view = event.data as ViewNode;
    const valid=validView(view,{value:0});if(valid)indexDraftFields(view);currentView=valid?view:undefined;
    draftStatus();root.render(valid ? <RuntimeView node={view} /> : <p role="alert">This application uses unsupported or invalid components. Execution stopped.</p>);
  };
  channel.start();
  draftStatus();
});
window.parent.postMessage({ kind: 'needware-ready' }, '*');
