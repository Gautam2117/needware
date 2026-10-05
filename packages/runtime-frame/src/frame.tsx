import React,{useState,useEffect} from 'react';
import { createRoot } from 'react-dom/client';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { Value } from '@needware/ir-types/Value';
import { supported } from '../../renderer/src/registry';
import {RuntimeDialog} from './dialog';
import {RuntimeInput} from './input';
import {valuesFor} from './bindings';

let channel: MessagePort | undefined;
let report=(message:string)=>{void message;};
function fire(node: ViewNode) {
  if (!node.action||node.disabled) return;
  let values:Record<string,Value>;try{values={...valuesFor(node),record_id:{type:'string',value:node.record??crypto.randomUUID()}};report('');}catch(error){report(String(error));return;}
  const scoped = node.event_fields ? Object.fromEntries(Object.entries(values).filter(([key]) => node.event_fields!.includes(key))) : values;
  channel?.postMessage({ action: node.action, values: scoped });
}
function Node({ node }: { node: ViewNode }) {
  if(!node.open)return null;
  const children = node.children.map(child => <Node key={child.id} node={child} />);
  switch (node.kind) {
    case 'heading': return <h2>{node.text}</h2>;
    case 'text': return <p>{node.text}</p>;
    case 'button': return <button type="button" disabled={node.disabled} onClick={event=>{event.currentTarget.focus();fire(node);}}>{node.text}</button>;
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
function RuntimeView({node}:{node:ViewNode}){const [error,setError]=useState('');useEffect(()=>{report=setError;return()=>{report=()=>{};};},[]);return <>{error&&<p role="alert">{error}</p>}<Node node={node}/></>;}
function validView(node: ViewNode, count: { value: number }, depth = 0): boolean {
  if (!node || typeof node.id !== 'string' || typeof node.text !== 'string' || typeof node.open!=='boolean'||typeof node.disabled!=='boolean'||typeof node.active_overlay!=='boolean'|| !Array.isArray(node.children) || !supported.has(node.kind) || depth > 32 || ++count.value > 4096) return false;
  return node.children.every(child => validView(child, count, depth + 1));
}
const element = document.getElementById('root');
if (!element) throw new Error('Missing trusted renderer root');
const root = createRoot(element);
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.kind !== 'needware-connect' || !event.ports[0] || channel) return;
  channel = event.ports[0];
  channel.onmessage = event => {
    const view = event.data as ViewNode;
    root.render(validView(view, { value: 0 }) ? <RuntimeView node={view} /> : <p role="alert">This application uses unsupported or invalid components. Execution stopped.</p>);
  };
  channel.start();
});
window.parent.postMessage({ kind: 'needware-ready' }, '*');
