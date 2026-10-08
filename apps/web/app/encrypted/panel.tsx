'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { EncryptedCommand, EncryptedEntry, EncryptedLoaded, CloudEntry, EpochRecipientChoice, SharedRevisionReview } from '../../../../packages/browser-host/src/encrypted-protocol';
import type { PackageInfo } from '../../../../packages/browser-host/src/protocol';
import { WorkerHost } from '../../../../packages/browser-host/src/worker-host';
import Sandbox from '../sandbox';
import EffectReview,{type EffectBroker,type EffectReviewHandle} from '../effect-review';
import OfflineLink from '../offline-link';
import type {SandboxHandle} from '../draft-recovery';
import RevisionReview from '../revision-review';
import { frameDocument } from '../frame-document';
import {registerOfflineShell} from '../../lib/offline-shell';
function download(name: string, value: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function EncryptedApplications() {
  const host = useRef<WorkerHost<EncryptedCommand>>(null); const [account, setAccount] = useState('');
  const sandbox=useRef<SandboxHandle>(null);
  const effectReview=useRef<EffectReviewHandle>(null);
  async function confirmLeave(){if(effectReview.current&&!effectReview.current.confirmLeave())return false;return !sandbox.current||await sandbox.current.confirmLeave();}
  const [entries, setEntries] = useState<EncryptedEntry[]>([]); const [review, setReview] = useState<{ info: PackageInfo; bytes: Uint8Array }>();
  const [cloudEntries,setCloudEntries]=useState<CloudEntry[]>([]);const [cloudReview,setCloudReview]=useState<EncryptedEntry>();
  const [schemaReview,setSchemaReview]=useState<SharedRevisionReview>();const [schemaTrust,setSchemaTrust]=useState(false);const [offlineAcknowledged,setOfflineAcknowledged]=useState(false);
  const [recoveryHistory,setRecoveryHistory]=useState<{revision:string;pending:number;state:string;package:Uint8Array}[]>([]);
  const [recipient,setRecipient]=useState<string>();const [allowWrite,setAllowWrite]=useState(false);const [shareConsent,setShareConsent]=useState(false);
  const [epochChoices,setEpochChoices]=useState<EpochRecipientChoice[]>([]);const [retainedDevices,setRetainedDevices]=useState<string[]>([]);
  const [loaded, setLoaded] = useState<EncryptedLoaded>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [status, setStatus] = useState('Open encrypted applications from your account to select a trusted browser vault.'); const [renderer, setRenderer] = useState<{ code: string; hash: string }>();
  const effectInstance=loaded?.instance;
  const effectBroker=useCallback<EffectBroker>(async(kind,id,outcome)=>{
    if(!host.current||!effectInstance)throw Error('Encrypted runtime is unavailable.');
    if(kind==='effect-review')return host.current.request({kind,account,instance:effectInstance});
    if(!id)throw Error('Effect identity is required.');
    if(kind==='record-effect')return host.current.request({kind,account,instance:effectInstance,id,outcome});
    return host.current.request({kind,account,instance:effectInstance,id});
  },[account,effectInstance]);
  const occupied=useRef(false);const syncing=useRef(false);
  useEffect(()=>{occupied.current=busy;},[busy]);
  useEffect(()=>{
    if(!loaded?.cloudEnabled||!account)return;
    const instance=loaded.instance;let active=true;let failures=0;let timer:ReturnType<typeof setTimeout>;
    const schedule=(seconds:number)=>{if(active)timer=setTimeout(attempt,seconds*1000+Math.random()*1000);};
    async function attempt(){
      if(!active)return;if(!navigator.onLine||occupied.current||syncing.current){schedule(10);return;}syncing.current=true;
      try{const result=await host.current?.request<{view:ViewNode;pendingUploads:number;more:boolean;cloudEnabled:boolean}>({kind:'sync',account,instance});
        if(active&&result){setLoaded(previous=>previous?.instance===instance?{...previous,...result}:previous);setStatus(result.pendingUploads||result.more?'Continuing encrypted synchronization…':'Encrypted changes saved to cloud');failures=0;schedule(result.pendingUploads||result.more?10:60);}}
      catch(failure){if(active){const value=failure as Error&{retryAfter?:number;status?:number};setStatus('Encrypted changes remain on this browser. Cloud synchronization will retry.');
        if(value.status===409){setLoaded(previous=>previous?.instance===instance?{...previous,reviewRequired:true}:previous);setError(value.message);return;}
        if(value.status===401||value.status===403){setError('Sign in or review this device grant before resuming cloud synchronization.');return;}failures++;schedule(Math.max(value.retryAfter||0,Math.min(300,5*2**Math.min(failures,6))));}}
      finally{syncing.current=false;}
    }
    const online=()=>{clearTimeout(timer);schedule(1);};window.addEventListener('online',online);schedule(10);
    return()=>{active=false;clearTimeout(timer);window.removeEventListener('online',online);};
  },[account,loaded?.instance,loaded?.cloudEnabled]);
  useEffect(() => {
    const id = new URLSearchParams(location.hash.slice(1)).get('account') || localStorage.getItem('needware-encrypted-account') || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return;
    localStorage.setItem('needware-encrypted-account',id);
    const cloudCommands = new Set(['sync', 'preview-cloud', 'rotate-epoch', 'cancel-epoch', 'epoch-recipients', 'share', 'preview-shared-revision', 'publish-shared-revision']);
    const client = new WorkerHost<EncryptedCommand>('/encrypted-worker.js', command => cloudCommands.has(command.kind) ? 300_000 : 30_000); host.current = client; let active = true;
    client.request<EncryptedEntry[]>({ kind: 'list', account: id }).then(async value => { if (active) { setAccount(id); setEntries(value); setStatus('Encrypted browser storage ready'); }
      const job=new URLSearchParams(location.hash.slice(1)).get('job');if(job&&/^[0-9a-f-]{36}$/.test(job)){const generated=await client.request<{info:PackageInfo;bytes:Uint8Array}>({kind:'preview-generation',account:id,job});if(active){setReview(generated);setStatus('Creation finished. Review its signer and permissions before saving it encrypted.');}}
    }).catch(failure => { if (active) { setError(String(failure)); setStatus('Trusted device or creation review required'); } });
    fetch('/frame.js').then(async response => {
      if (!response.ok) throw new Error('Renderer download failed'); const code = (await response.text()).replace(/<\/script/gi,'<\\/script');
      const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code));
      if (active) setRenderer({ code, hash: btoa(String.fromCharCode(...new Uint8Array(digest))) });
    }).catch(failure => { if (active) setError(String(failure)); });
    registerOfflineShell().catch(()=>{if(active)setError('Offline shell could not finish caching. Keep this page online and reload before disconnecting.');});
    return () => { active = false; client.close(); host.current = null; };
  },[]);
  async function run(action: () => Promise<void>) { occupied.current=true;setBusy(true); setError(''); try { await action(); } catch (failure) { setError(String(failure));
    if(loaded&&(failure as Error&{status?:number}).status===409)setLoaded(previous=>previous?.instance===loaded.instance?{...previous,reviewRequired:true}:previous);
    if(loaded)try{const value=await host.current?.request<{epochPending:boolean}>({kind:'epoch-state',account,instance:loaded.instance});if(value)setLoaded(previous=>previous?.instance===loaded.instance?{...previous,...value}:previous);}catch{/* Preserve the original failure. */}
  } finally { occupied.current=false;setBusy(false); } }
  async function refresh() { const value = await host.current?.request<EncryptedEntry[]>({ kind: 'list', account }); if (value) setEntries(value); }
  async function inspect(bytes: Uint8Array) { const info = await host.current?.request<PackageInfo>({ kind: 'inspect', account, bytes }); if (info) { setReview({ info, bytes }); setCloudReview(undefined); } }
  async function show(value: EncryptedLoaded | undefined) { if (value) { setSchemaReview(undefined);setSchemaTrust(false);setRecoveryHistory([]);setRecipient(undefined);setAllowWrite(false);setShareConsent(false);setLoaded(value); setEpochChoices([]);setRetainedDevices([]);setReview(undefined); setStatus('Encrypted browser storage ready'); await refresh(); } }
  async function remove(document: string) {
    if(loaded?.document===document&&!await confirmLeave())return;
    if (!window.confirm('Delete this encrypted application from this browser? Export anything you want to keep first.')) return;
    await host.current?.request({ kind: 'delete', account, document }); if (loaded?.document === document) setLoaded(undefined); await refresh();
  }
  async function cloudList(){const list=await host.current?.request<CloudEntry[]>({kind:'cloud-list',account});if(list)setCloudEntries(list);}
  async function previewCloud(document:string,pin?:string,ownerEpoch?:number){const value=await host.current?.request<EncryptedEntry>({kind:'preview-cloud',account,document,pin,ownerEpoch,consent:true});if(value){setCloudReview(value);setOfflineAcknowledged(false);setReview(undefined);}}
  async function sync(){if(!loaded||syncing.current)return;syncing.current=true;try{const result=await host.current?.request<{view:ViewNode;pendingUploads:number;more:boolean;cloudEnabled:boolean}>({kind:'sync',account,instance:loaded.instance});if(result){setLoaded(previous=>previous?.instance===loaded.instance?{...previous,...result}:previous);setStatus(result.pendingUploads||result.more?'Cloud batch saved. Continue synchronization for remaining changes.':'Encrypted changes saved to cloud');}}finally{syncing.current=false;}}
  async function rotate(){
    if(!loaded||!window.confirm(`Create fresh document keys, keep access for ${retainedDevices.length} selected devices, and remove all other collaborator grants? Old downloaded data cannot be erased. Shared history is retained.`))return;
    const retained=epochChoices.filter(choice=>retainedDevices.includes(`${choice.account_id}:${choice.device_id}`)).map(choice=>({certificate:JSON.stringify(choice.certificate),write:choice.account_id===account||choice.membership?.role==='write'}));
    const result=await host.current?.request<Partial<EncryptedLoaded>>({kind:'rotate-epoch',account,instance:loaded.instance,consent:true,retained});
    if(result){setLoaded(previous=>previous?.instance===loaded.instance?{...previous,...result}:previous);setEpochChoices([]);setRetainedDevices([]);setRecipient(undefined);setAllowWrite(false);setShareConsent(false);setStatus('Fresh document keys activated. Selected devices keep access; other collaborator grants were removed.');}
  }
  async function previewShared(bytes:Uint8Array){
    if(!loaded)return;const reviewed=await host.current?.request<SharedRevisionReview>({kind:'preview-shared-revision',account,instance:loaded.instance,bytes});
    if(reviewed){setSchemaReview(reviewed);setSchemaTrust(false);const choices=await host.current?.request<EpochRecipientChoice[]>({kind:'epoch-recipients',account,instance:loaded.instance});setEpochChoices(choices??[]);setRetainedDevices([]);}
  }
  async function publishShared(destructive:boolean){
    if(!loaded||!schemaReview||!schemaTrust)return;
    if(!await confirmLeave())return;
    const retained=epochChoices.filter(choice=>retainedDevices.includes(`${choice.account_id}:${choice.device_id}`)).map(choice=>({certificate:JSON.stringify(choice.certificate),write:choice.account_id===account||choice.membership?.role==='write'}));
    await show(await host.current?.request<EncryptedLoaded>({kind:'publish-shared-revision',account,instance:loaded.instance,digest:schemaReview.review_digest,destructive,permissions:true,retained}));setSchemaReview(undefined);setStatus('Reviewed shared revision published. The previous revision remains in recovery history.');
  }
  const frame = frameDocument(renderer);
  return <><header><OfflineLink href="/">needware /</OfflineLink><nav><OfflineLink href="/account">Your account</OfflineLink></nav></header><main id="main">
    <span className="eyebrow">Your trusted browser</span><h1>Encrypted applications</h1><p>Your application and its data are encrypted before being saved on this browser. Already saved applications work offline after the shell finishes caching.</p>
    <p className="notice">Choose Sync to upload encrypted definitions and shared changes to your account. Other application state stays on this device. Pending changes remain durable here until the service acknowledges them. Cloud recovery needs your account keys and a current document grant.</p>
    <div role="status" aria-live="polite">{busy ? 'Saving encrypted application…' : status}</div>{error && <p className="notice error" role="alert">{error}</p>}
    <div className="toolbar"><button disabled={busy || !account} onClick={() => run(async () => { const bytes = await host.current?.request<Uint8Array>({ kind: 'example', account }); if (bytes) await inspect(bytes); })}>Try encrypted habit tracker</button>
      <label className="file-label">Import encrypted-library application<input type="file" accept=".need" disabled={busy || !account} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => { if (file.size > 32*1024*1024) throw new Error('Package exceeds 32 MiB'); await inspect(new Uint8Array(await file.arrayBuffer())); }); }} /></label>
      <button disabled={busy||!account} onClick={()=>run(cloudList)}>Find cloud applications</button>
      <button disabled={busy||!account} onClick={()=>run(async()=>{const identity=await host.current?.request({kind:'collaboration-identity',account});if(identity)download('needware-collaboration-device.json',JSON.stringify(identity),'application/json');})}>Download collaboration device identity</button>
      <label className="file-label">Open document invitation<input type="file" accept=".json,application/json" disabled={busy||!account} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void run(async()=>{if(file.size>16*1024)throw new Error('Invitation size limit');const value=JSON.parse(await file.text());if(value.format!=='needware-document-invitation-v1'||!value.document||!value.authority||!value.ownerEpoch||value.context?.document!==value.document)throw new Error('Invalid document invitation');await previewCloud(value.document,value.authority,value.ownerEpoch);});}} /></label></div>
    {!!cloudEntries.length&&<section aria-label="Cloud applications"><h2>Encrypted cloud applications</h2><p>Review the signer and permissions before saving a cloud package on this browser.</p>{cloudEntries.map(entry=><article className="app-card" key={entry.id}><strong>Encrypted application {entry.id.slice(0,8)}</strong><p>{entry.ready?'Encrypted package ready':'Upload incomplete; resume synchronization on its original browser'}</p><button disabled={busy||!entry.ready||entries.some(local=>local.document===entry.id)} onClick={()=>run(()=>previewCloud(entry.id))}>Review cloud application</button></article>)}</section>}
    {cloudReview&&<section className="review" aria-label="Cloud package review"><h2>Review {cloudReview.info.application.title}</h2><p>Verified package signer:</p><code>{cloudReview.info.signers.join(', ')}</code><p>Package digest: <code>{cloudReview.info.digest}</code></p><ul>{cloudReview.info.application.capabilities.map((cap,index)=><li key={index}>{JSON.stringify(cap)}</li>)}</ul>
      {cloudReview.offline&&<><p>{cloudReview.offline.pending} offline changes remain on the previous revision. They will be kept in recovery history and will not be uploaded with stale keys.</p><details><summary>Review preserved offline data</summary><pre>{cloudReview.offline.state}</pre></details><label><input type="checkbox" checked={offlineAcknowledged} onChange={event=>setOfflineAcknowledged(event.target.checked)} /> Keep my old revision and offline edits in recovery history, and open the current shared revision</label></>}
      <button disabled={busy||Boolean(cloudReview.offline&&!offlineAcknowledged)} onClick={()=>run(async()=>{if(!await confirmLeave())return;await show(await host.current?.request<EncryptedLoaded>({kind:'accept-cloud',account,document:cloudReview.document,consent:true,preserveOffline:offlineAcknowledged}));setCloudReview(undefined);})}>Trust signer and import cloud application</button><button disabled={busy} onClick={()=>run(async()=>{await host.current?.request({kind:'cancel-cloud',account});setCloudReview(undefined);})}>Cancel cloud import</button></section>}
    {review && <section className="review" aria-label="Application permissions"><h2>Review {review.info.application.title}</h2><p>Verified package signer:</p><code>{review.info.signers.join(', ')}</code><p>Only the collections listed in synchronized storage permissions enter shared history. Other state stays on this device.</p><ul>{review.info.application.capabilities.map((cap,index)=><li key={index}>{cap.kind === 'storage' ? `${cap.write ? 'Read and write' : 'Read'} ${cap.collections.join(', ')} ${cap.synchronized ? 'with encrypted synchronization' : 'on this device'}` : cap.kind === 'collaboration' ? `Collaboration: ${cap.write ? 'editable' : 'read only'}` : JSON.stringify(cap)}</li>)}</ul>
      <button className="primary" disabled={busy} onClick={() => run(async () => {if(!await confirmLeave())return;await show(await host.current?.request<EncryptedLoaded>({ kind: 'create', account, bytes: review.bytes, consent: true }));})}>Trust signer and save encrypted application</button><button disabled={busy} onClick={()=>setReview(undefined)}>Cancel</button></section>}
    {loaded && renderer && <section className="viewer" aria-label="Encrypted application viewer"><div className="security-bar"><strong>{loaded.info.application.title}</strong><p>Encrypted browser storage · {loaded.pendingUploads} pending {loaded.pendingUploads === 1 ? 'change' : 'changes'}</p><code>Digest {loaded.info.digest}</code><div className="toolbar">
      <button disabled={busy} onClick={()=>run(async()=>{const bytes=await host.current?.request<Uint8Array>({kind:'export-package',account,instance:loaded.instance});if(bytes)download(`${loaded.info.application.title}.need`,new Uint8Array(bytes),'application/vnd.needware.package');})}>Export plaintext package</button>
      <button disabled={busy} onClick={()=>run(async()=>{const state=await host.current?.request<string>({kind:'export-state',account,instance:loaded.instance});if(state)download('needware-state.json',state,'application/json');})}>Export plaintext data</button>
      <button disabled={busy} onClick={()=>run(()=>remove(loaded.document))}>Delete encrypted application</button></div></div>
      <div className="toolbar"><button disabled={busy} onClick={()=>run(sync)}>Sync encrypted application</button></div>
      {loaded.reviewRequired&&<section aria-label="Shared revision review required"><h2>Review the updated shared application</h2><p>Your old revision and offline edits are preserved. Shared writes are paused until you review the current package.</p><button disabled={busy} onClick={()=>run(()=>previewCloud(loaded.document))}>Review current shared revision</button></section>}
      {loaded.cloudEnabled&&loaded.isOwner&&!loaded.reviewRequired&&<label className="file-label">Review signed shared revision<input type="file" accept=".need" disabled={busy||loaded.epochPending} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void run(async()=>{if(file.size>32*1024*1024)throw new Error('Package exceeds 32 MiB');await previewShared(new Uint8Array(await file.arrayBuffer()));});}} /></label>}
      {schemaReview&&<section aria-label="Shared schema revision"><p>Verified signer: <code>{schemaReview.signers.join(', ')}</code></p><p>Unselected collaborators lose access to the new revision. Their old offline edits remain on their browsers for review.</p><fieldset><legend>Keep access to the new revision</legend>{epochChoices.map(choice=>{const id=`${choice.account_id}:${choice.device_id}`;return <label key={id}><input type="checkbox" checked={retainedDevices.includes(id)} onChange={event=>setRetainedDevices(previous=>event.target.checked?[...previous,id]:previous.filter(value=>value!==id))} />{choice.label} ({choice.device_id.slice(0,8)})</label>;})}</fieldset>
        <label><input type="checkbox" checked={schemaTrust} onChange={event=>setSchemaTrust(event.target.checked)} /> I trust this signer, approve this shared revision and its permissions, and approve the selected access list</label>
        <RevisionReview key={schemaReview.review_digest} report={schemaReview.runtime} busy={busy} approvalBlocked={!schemaTrust} activate={destructive=>{void run(()=>publishShared(destructive));}} cancel={()=>{void run(async()=>{await host.current?.request({kind:'cancel-shared-revision',account,instance:loaded.instance});setSchemaReview(undefined);});}} />
      </section>}
      <details><summary>Recovery history</summary><p>Older revisions and offline edits stay on this browser. Exports contain plaintext application data.</p><button disabled={busy} onClick={()=>run(async()=>{const history=await host.current?.request<typeof recoveryHistory>({kind:'recovery-history',account,instance:loaded.instance});if(history)setRecoveryHistory(history);})}>Review recovery history</button>
        {recoveryHistory.map((item,index)=><article key={index}><p>Revision {item.revision.slice(0,8)} · {item.pending} preserved offline changes</p><button disabled={busy} onClick={()=>download(`needware-recovery-${index}.json`,item.state,'application/json')}>Export recovery data {index+1}</button><button disabled={busy} onClick={()=>download(`needware-recovery-${index}.need`,new Uint8Array(item.package),'application/vnd.needware.package')}>Export recovery package {index+1}</button></article>)}
      </details>
      {loaded.cloudEnabled&&loaded.isOwner&&<details><summary>Document keys and access</summary><p>Choose devices to keep access before rotating keys. Unselected collaborators lose access to future cloud data. Old packages and signed history remain encrypted in the archive. Previously downloaded data remains with its recipients. Other owner devices can recover a fresh grant.</p>
        <button disabled={busy||loaded.epochPending} onClick={()=>run(async()=>{const choices=await host.current?.request<EpochRecipientChoice[]>({kind:'epoch-recipients',account,instance:loaded.instance});if(choices){setEpochChoices(choices);setRetainedDevices([]);}})}>Review devices to keep access</button>
        {epochChoices.length>0&&<fieldset><legend>Keep access after rotation</legend>{epochChoices.map(choice=>{const id=`${choice.account_id}:${choice.device_id}`;return <label key={id}><input type="checkbox" disabled={busy||loaded.epochPending} checked={retainedDevices.includes(id)} onChange={event=>setRetainedDevices(previous=>event.target.checked?[...previous,id]:previous.filter(value=>value!==id))} />{choice.label} ({choice.device_id.slice(0,8)}) — {choice.account_id===account?'Your device':choice.membership?.role==='write'?'Collaborator, can edit':'Collaborator, can view'}</label>;})}</fieldset>}
        <button disabled={busy} onClick={()=>run(rotate)}>Rotate document keys and remove collaborator grants</button>
        {loaded.epochPending&&<><p>Key rotation is pending. Changes are paused; Sync resumes the saved intent.</p><button disabled={busy} onClick={()=>run(async()=>{const result=await host.current?.request<Partial<EncryptedLoaded>>({kind:'cancel-epoch',account,instance:loaded.instance});if(result)setLoaded(previous=>previous?{...previous,...result}:previous);})}>Cancel pending key rotation</button></>}
      </details>}
      {loaded.isOwner&&<details><summary>Share this application</summary><p>Open a collaboration device file from the recipient&apos;s registered browser. Compare its device identity with that person. Sharing reveals only the declared shared collections; device-local state stays here.</p>
        <label className="file-label">Recipient collaboration device<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void run(async()=>{if(file.size>16*1024)throw new Error('Recipient file size limit');const value=JSON.parse(await file.text());if(value.format!=='needware-collaboration-device-v1'||!value.certificate?.device?.id)throw new Error('Invalid recipient device file');setRecipient(JSON.stringify(value.certificate));setAllowWrite(false);setShareConsent(false);});}} /></label>
        {recipient&&<p>Recipient device: <code>{JSON.parse(recipient).device.id}</code></p>}<label><input type="checkbox" checked={allowWrite} onChange={event=>{setAllowWrite(event.target.checked);setShareConsent(false);}} /> Allow this recipient to edit shared data</label>
        <label><input type="checkbox" checked={shareConsent} onChange={event=>setShareConsent(event.target.checked)} /> I verified this recipient device and approve sharing</label>
        <button disabled={busy||!recipient||!shareConsent} onClick={()=>run(async()=>{if(!recipient)return;const invitation=await host.current?.request({kind:'share',account,instance:loaded.instance,certificate:recipient,write:allowWrite,consent:true});if(invitation){download('needware-document-invitation.json',JSON.stringify(invitation),'application/json');setStatus('Recipient grant saved. Give the invitation to that person.');}})}>Approve recipient and download invitation</button>
      </details>}
      <EffectReview ref={effectReview} key={`effect:${loaded.instance}`} broker={effectBroker} view={loaded.view} completed={result=>setLoaded(previous=>previous?.instance===loaded.instance?{...previous,...result}:previous)} />
      <Sandbox ref={sandbox} binding={`encrypted:${account}:${loaded.document}`} digest={loaded.info.digest} key={loaded.instance} title={loaded.info.application.title} document={frame} view={loaded.view} error={setError} durable={{save:async(id,drafts)=>{if(!host.current)throw Error('Encrypted runtime is unavailable.');await host.current.request({kind:'save-drafts',account,instance:loaded.instance,id,digest:loaded.info.digest,drafts});},summaries:async()=>{if(!host.current)throw Error('Encrypted runtime is unavailable.');return host.current.request({kind:'draft-summaries',account,instance:loaded.instance});},load:async(summary)=>{if(!host.current)throw Error('Encrypted runtime is unavailable.');return host.current.request({kind:'load-draft',account,instance:loaded.instance,source:summary.source,id:summary.id,generation:summary.generation});},forget:async(summary)=>{if(!host.current)throw Error('Encrypted runtime is unavailable.');await host.current.request({kind:'forget-draft',account,instance:loaded.instance,id:summary.id,generation:summary.generation});}}} selectPage={async(node,offset)=>{if(loaded.reviewRequired)throw Error('Review the current shared revision before changing pages.');if(!host.current)throw Error('Encrypted runtime is unavailable.');const result=await host.current.request<{view:ViewNode;pendingUploads:number}>({kind:'select-page',account,instance:loaded.instance,node,offset});setLoaded(previous=>previous?.instance===loaded.instance?{...previous,...result}:previous);}} dispatch={async(action,values)=>{if(loaded.reviewRequired)throw Error('Review the current shared revision before editing. Your old offline changes are preserved.');if(!host.current)throw Error('Encrypted runtime is unavailable.');try{const result=await host.current.request<{view:ViewNode;pendingUploads:number}>({kind:'dispatch',account,instance:loaded.instance,action,values});setLoaded(previous=>previous?.instance===loaded.instance?{...previous,...result}:previous);}catch(failure){if((failure as Error&{status?:number}).status===409)setLoaded(previous=>previous?.instance===loaded.instance?{...previous,reviewRequired:true}:previous);throw failure;}}} /></section>}
    <section aria-label="Encrypted library"><h2>On this browser</h2>{entries.length ? <div className="library">{entries.map(entry=><article className="app-card" key={entry.document} data-document={entry.document}><strong>{entry.info.application.title}</strong><p>Signed package · Encrypted data</p><button disabled={busy} onClick={()=>run(async()=>{if(!await confirmLeave())return;await show(await host.current?.request<EncryptedLoaded>({kind:'open',account,document:entry.document,consent:true}));})}>Open {entry.info.application.title}</button></article>)}</div> : account ? <p>No encrypted applications saved yet.</p> : <p>Your encrypted library has not been opened. <OfflineLink href="/account">Open your encrypted account</OfflineLink> to select this browser’s vault. Saved applications stay in their existing vault.</p>}</section>
    <footer>Exported package and data files are plaintext. Keep them private. Browser storage can be cleared or evicted.</footer>
  </main></>;
}
