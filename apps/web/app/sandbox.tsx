'use client';
import { useEffect, useRef,useState,useImperativeHandle,useCallback,type Ref } from 'react';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { Value } from '@needware/ir-types/Value';
import { frameEvent } from '../../../packages/browser-host/src/protocol';
import {DraftRecovery,validDraftStatus,type DraftStatus,type SandboxHandle} from './draft-recovery';
export default function Sandbox({ title, document, view, dispatch, error,binding,digest,ref }: {
  title: string; document: string; view: ViewNode;
  dispatch(action: string, values: Record<string, Value>): Promise<void>; error(message: string): void;
  binding:string;digest:string;ref?:Ref<SandboxHandle>;
}) {
  const port = useRef<MessagePort | null>(null);
  const latestView = useRef(view);
  const iframe = useRef<HTMLIFrameElement>(null);
  const callbacks=useRef({dispatch,error});const current=useRef<DraftStatus>({count:0,pending:0});const [status,setStatus]=useState<DraftStatus>({count:0,pending:0});
  const [ready,setReady]=useState(false);const leaveApproved=useRef(false);
  const requests=useRef(new Map<string,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>());
  useEffect(()=>{callbacks.current={dispatch,error};},[dispatch,error]);
  const request=useCallback((operation:'status'|'export'|'import',value?:unknown):Promise<unknown>=>new Promise((resolve,reject)=>{if(!port.current){reject(Error('Application is not ready.'));return;}if(requests.current.size>=8){reject(Error('Wait for pending draft recovery requests.'));return;}const id=crypto.randomUUID();const timer=setTimeout(()=>{requests.current.delete(id);reject(Error('Draft recovery timed out. Keep this page open and try again.'));},5000);requests.current.set(id,{resolve,reject,timer});port.current.postMessage({kind:'needware-draft-request',request:id,operation,value});}),[]);
  const confirmLeave=useCallback(async()=>{const value=await request('status');if(!validDraftStatus(value))throw Error('Invalid draft status.');if(value.pending)throw Error('Wait for pending changes before leaving this application.');return !value.count||window.confirm('Discard unsaved inputs and leave this application? Cancel to save them or export a recovery file first.');},[request]);
  useImperativeHandle(ref,()=>({confirmLeave}),[confirmLeave]);
  useEffect(()=>{const before=(event:BeforeUnloadEvent)=>{if(leaveApproved.current){leaveApproved.current=false;return;}if(current.current.count||current.current.pending){event.preventDefault();event.returnValue='';}};const navigate=(event:MouseEvent)=>{const link=event.target instanceof Element?event.target.closest('a'):null;if(!link||link.download||link.target==='_blank'||event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||(!current.current.count&&!current.current.pending))return;const target=new URL(link.href);if(target.origin===location.origin&&target.pathname===location.pathname&&target.search===location.search&&target.hash)return;event.preventDefault();event.stopPropagation();void confirmLeave().then(accepted=>{if(accepted){leaveApproved.current=true;try{location.assign(link.href);}catch(failure){leaveApproved.current=false;throw failure;}}}).catch(failure=>callbacks.current.error(String(failure)));};window.addEventListener('beforeunload',before);window.document.addEventListener('click',navigate,true);return()=>{window.removeEventListener('beforeunload',before);window.document.removeEventListener('click',navigate,true);};},[confirmLeave]);
  useEffect(() => { latestView.current = view; port.current?.postMessage(view); }, [view]);
  useEffect(() => () => { port.current?.close(); port.current = null;for(const item of requests.current.values()){clearTimeout(item.timer);item.reject(Error('Application closed.'));}requests.current.clear(); }, []);
  function connect() {
    port.current?.close(); const channel = new MessageChannel(); port.current = channel.port1;
    channel.port1.onmessage = event => {
      if(event.data?.kind==='needware-draft-status'){if(validDraftStatus(event.data)){current.current={count:event.data.count,pending:event.data.pending};setStatus(current.current);setReady(event.data.ready===true);}return;}
      if(event.data?.kind==='needware-draft-reply'){const item=requests.current.get(event.data.request);if(!item)return;requests.current.delete(event.data.request);clearTimeout(item.timer);if(event.data.ok===true)item.resolve(event.data.value);else item.reject(Error(typeof event.data.error==='string'?event.data.error:'Draft recovery failed.'));return;}
      if (!frameEvent(event.data)) { error('Invalid application event was rejected.'); return; }
      const message=event.data as typeof event.data&{request?:unknown};if(typeof message.request!=='string'||!/^[0-9a-f-]{36}$/.test(message.request)){callbacks.current.error('Invalid application request was rejected.');return;}
      const reply=(ok:boolean)=>{if(port.current===channel.port1)channel.port1.postMessage({kind:'needware-action-result',request:message.request,ok});};
      callbacks.current.dispatch(message.action,message.values).then(()=>reply(true)).catch(failure=>{reply(false);callbacks.current.error(String(failure));});
    };
    channel.port1.start();
    iframe.current?.contentWindow?.postMessage({ kind: 'needware-connect' }, '*', [channel.port2]);
    channel.port1.postMessage(latestView.current);
  }
  // Load fires after the trusted inline renderer has installed its channel listener.
  return <><DraftRecovery ready={ready} status={status} request={request} binding={binding} digest={digest} error={error}/><iframe ref={iframe} title={`${title} application`} sandbox="allow-scripts" srcDoc={document} onLoad={connect} /></>;
}
