'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { EncryptedCommand, EncryptedEntry, EncryptedLoaded } from '../../../../packages/browser-host/src/encrypted-protocol';
import type { PackageInfo } from '../../../../packages/browser-host/src/protocol';
import { WorkerHost } from '../../../../packages/browser-host/src/worker-host';
import Sandbox from '../sandbox';
import { frameDocument } from '../frame-document';
function download(name: string, value: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function EncryptedApplications() {
  const host = useRef<WorkerHost<EncryptedCommand>>(null); const [account, setAccount] = useState('');
  const [entries, setEntries] = useState<EncryptedEntry[]>([]); const [review, setReview] = useState<{ info: PackageInfo; bytes: Uint8Array }>();
  const [loaded, setLoaded] = useState<EncryptedLoaded>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [status, setStatus] = useState('Open encrypted applications from your account to select a trusted browser vault.'); const [renderer, setRenderer] = useState<{ code: string; hash: string }>();
  useEffect(() => {
    const id = new URLSearchParams(location.hash.slice(1)).get('account') || localStorage.getItem('needware-encrypted-account') || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return;
    localStorage.setItem('needware-encrypted-account',id);
    const client = new WorkerHost<EncryptedCommand>('/encrypted-worker.js'); host.current = client; let active = true;
    client.request<EncryptedEntry[]>({ kind: 'list', account: id }).then(value => { if (active) { setAccount(id); setEntries(value); setStatus('Encrypted browser storage ready'); } }).catch(failure => { if (active) { setError(String(failure)); setStatus('Trusted device required'); } });
    fetch('/frame.js').then(async response => {
      if (!response.ok) throw new Error('Renderer download failed'); const code = (await response.text()).replace(/<\/script/gi,'<\\/script');
      const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code));
      if (active) setRenderer({ code, hash: btoa(String.fromCharCode(...new Uint8Array(digest))) });
    }).catch(failure => { if (active) setError(String(failure)); });
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    return () => { active = false; client.close(); host.current = null; };
  },[]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (failure) { setError(String(failure)); } finally { setBusy(false); } }
  async function refresh() { const value = await host.current?.request<EncryptedEntry[]>({ kind: 'list', account }); if (value) setEntries(value); }
  async function inspect(bytes: Uint8Array) { const info = await host.current?.request<PackageInfo>({ kind: 'inspect', account, bytes }); if (info) setReview({ info, bytes }); }
  async function show(value: EncryptedLoaded | undefined) { if (value) { setLoaded(value); setReview(undefined); setStatus('Encrypted browser storage ready'); await refresh(); } }
  async function remove(document: string) {
    if (!window.confirm('Delete this encrypted application from this browser? Export anything you want to keep first.')) return;
    await host.current?.request({ kind: 'delete', account, document }); if (loaded?.document === document) setLoaded(undefined); await refresh();
  }
  const frame = frameDocument(renderer);
  return <><header><Link href="/">needware /</Link><nav><Link href="/account">Your account</Link></nav></header><main id="main">
    <span className="eyebrow">Your trusted browser</span><h1>Encrypted applications</h1><p>Your application and its data are encrypted before being saved on this browser. Already saved applications work offline after the shell finishes caching.</p>
    <p className="notice">Cloud document uploads are being built. Pending changes below are durable on this browser; they have not been uploaded. An account recovery file restores account keys; export application copies to preserve data if browser storage is lost.</p>
    <div role="status" aria-live="polite">{busy ? 'Saving encrypted application…' : status}</div>{error && <p className="notice error" role="alert">{error}</p>}
    <div className="toolbar"><button disabled={busy || !account} onClick={() => run(async () => { const bytes = await host.current?.request<Uint8Array>({ kind: 'example', account }); if (bytes) await inspect(bytes); })}>Try encrypted habit tracker</button>
      <label className="file-label">Import encrypted-library application<input type="file" accept=".need" disabled={busy || !account} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => { if (file.size > 32*1024*1024) throw new Error('Package exceeds 32 MiB'); await inspect(new Uint8Array(await file.arrayBuffer())); }); }} /></label></div>
    {review && <section className="review" aria-label="Application permissions"><h2>Review {review.info.application.title}</h2><p>Verified package signer:</p><code>{review.info.signers.join(', ')}</code><p>Only the collections listed in synchronized storage permissions enter shared history. Other state stays on this device.</p><ul>{review.info.application.capabilities.map((cap,index)=><li key={index}>{cap.kind === 'storage' ? `${cap.write ? 'Read and write' : 'Read'} ${cap.collections.join(', ')} ${cap.synchronized ? 'with encrypted synchronization' : 'on this device'}` : cap.kind === 'collaboration' ? `Collaboration: ${cap.write ? 'editable' : 'read only'}` : JSON.stringify(cap)}</li>)}</ul>
      <button className="primary" disabled={busy} onClick={() => run(async () => show(await host.current?.request<EncryptedLoaded>({ kind: 'create', account, bytes: review.bytes, consent: true })))}>Trust signer and save encrypted application</button><button disabled={busy} onClick={()=>setReview(undefined)}>Cancel</button></section>}
    {loaded && renderer && <section className="viewer" aria-label="Encrypted application viewer"><div className="security-bar"><strong>{loaded.info.application.title}</strong><p>Encrypted browser storage · {loaded.pendingUploads} pending {loaded.pendingUploads === 1 ? 'change' : 'changes'}</p><code>Digest {loaded.info.digest}</code><div className="toolbar">
      <button disabled={busy} onClick={()=>run(async()=>{const bytes=await host.current?.request<Uint8Array>({kind:'export-package',account,instance:loaded.instance});if(bytes)download(`${loaded.info.application.title}.need`,new Uint8Array(bytes),'application/vnd.needware.package');})}>Export plaintext package</button>
      <button disabled={busy} onClick={()=>run(async()=>{const state=await host.current?.request<string>({kind:'export-state',account,instance:loaded.instance});if(state)download('needware-state.json',state,'application/json');})}>Export plaintext data</button>
      <button disabled={busy} onClick={()=>run(()=>remove(loaded.document))}>Delete encrypted application</button></div></div>
      <Sandbox key={loaded.instance} title={loaded.info.application.title} document={frame} view={loaded.view} error={setError} dispatch={(action,values)=>{void run(async()=>{const result=await host.current?.request<{view:ViewNode;pendingUploads:number}>({kind:'dispatch',account,instance:loaded.instance,action,values});if(result)setLoaded(previous=>previous?.instance===loaded.instance?{...previous,...result}:previous);});}} /></section>}
    <section aria-label="Encrypted library"><h2>On this browser</h2>{entries.length ? <div className="library">{entries.map(entry=><article className="app-card" key={entry.document}><strong>{entry.info.application.title}</strong><p>Signed package · Encrypted data</p><button disabled={busy} onClick={()=>run(async()=>show(await host.current?.request<EncryptedLoaded>({kind:'open',account,document:entry.document,consent:true})))}>Open {entry.info.application.title}</button></article>)}</div> : <p>No encrypted applications saved yet.</p>}</section>
    <footer>Exported package and data files are plaintext. Keep them private. Browser storage can be cleared or evicted.</footer>
  </main></>;
}
