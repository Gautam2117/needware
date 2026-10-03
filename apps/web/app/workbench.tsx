'use client';
import { useEffect, useRef, useState } from 'react';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { Command, LibraryEntry, Loaded, PackageInfo, WorkerReply } from '../../../packages/browser-host/src/protocol';
import { frameEvent } from '../../../packages/browser-host/src/protocol';

class Host {
  private port: Worker;
  private serial = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor() {
    this.port = new Worker('/runtime-worker.js', { type: 'module' });
    this.port.onerror = () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Runtime could not start. Reconnect to finish downloading offline support.')); } this.pending.clear(); };
    this.port.onmessage = (event: MessageEvent<WorkerReply>) => {
      const response = event.data; const request = this.pending.get(response.id);
      if (!request) return; clearTimeout(request.timer); this.pending.delete(response.id);
      if (response.ok) request.resolve(response.data); else request.reject(new Error(response.error ?? 'Runtime operation failed'));
    };
  }
  request<T>(command: Command): Promise<T> {
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Runtime timed out. Reopen the application to recover its last durable state.')); }, 30_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer }); this.port.postMessage({ id, command });
    });
  }
  close() { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Host closed')); } this.pending.clear(); this.port.terminate(); }
}
function download(filename: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const frameStyle = `:root{color-scheme:light dark;font-family:Arial,sans-serif;color:#1c2623;background:#fffefa}body{margin:0;padding:28px}h2{font-size:28px;letter-spacing:-1px}p{line-height:1.5}label{display:block;margin:16px 0;font-size:14px}input,textarea{box-sizing:border-box;display:block;width:100%;font:inherit;padding:12px;border:1px solid #ccd5ce;border-radius:8px;margin-top:7px;background:transparent;color:inherit}button{font:inherit;cursor:pointer;background:#18594e;color:white;border:0;padding:10px 16px;border-radius:8px;margin:7px 8px 7px 0}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #579fd6;outline-offset:3px}.card{padding:17px;border:1px solid #d9dfd6;border-radius:12px;margin:14px 0}.row{display:flex;gap:12px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.empty{color:#65746a}.spacer{height:20px}@media(prefers-color-scheme:dark){:root{background:#18231e;color:#e8ede7}.card{border-color:#35453c}}`;
export default function Workbench() {
  const host = useRef<Host | null>(null); const iframe = useRef<HTMLIFrameElement>(null); const framePort = useRef<MessagePort | null>(null); const latestView = useRef<ViewNode | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]); const [review, setReview] = useState<{ info: PackageInfo; bytes: Uint8Array } | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null); const [view, setView] = useState<ViewNode | null>(null);
  const [renderer, setRenderer] = useState<{ code: string; hash: string } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [prompt, setPrompt] = useState(''); const [status, setStatus] = useState('Starting local runtime');
  useEffect(() => {
    const client = new Host(); host.current = client;
    fetch('/frame.js').then(async response => {
      if (!response.ok) throw new Error('Renderer download failed.');
      const code = (await response.text()).replace(/<\/script/gi, '<\\/script');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
      setRenderer({ code, hash: btoa(String.fromCharCode(...new Uint8Array(digest))) });
    }).catch(error => setError(String(error)));
    client.request<LibraryEntry[]>({ kind: 'library' }).then(entries => { setLibrary(entries); setStatus('Local runtime ready'); }).catch(error => { setError(String(error)); setStatus('Storage unavailable'); });
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* Offline readiness is shown only after successful caching. */ });
    return () => { client.close(); host.current = null; };
  }, []);
  useEffect(() => { latestView.current = view; if (view) framePort.current?.postMessage(view); }, [view]);
  useEffect(() => {
    if (!loaded) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.data?.kind !== 'needware-ready') return;
      const channel = new MessageChannel(); framePort.current?.close(); framePort.current = channel.port1;
      channel.port1.onmessage = event => {
        if (!frameEvent(event.data)) { setError('Invalid application event was rejected.'); return; }
        host.current?.request<ViewNode>({ kind: 'dispatch', action: event.data.action, values: event.data.values }).then(setView).catch(error => setError(String(error)));
      };
      channel.port1.start(); iframe.current.contentWindow?.postMessage({ kind: 'needware-connect' }, '*', [channel.port2]);
      if (latestView.current) channel.port1.postMessage(latestView.current);
    };
    window.addEventListener('message', onMessage); return () => { window.removeEventListener('message', onMessage); framePort.current?.close(); framePort.current = null; };
  }, [loaded, renderer]);
  async function run(operation: () => Promise<void>) { setBusy(true); setError(''); try { await operation(); } catch (error) { setError(String(error)); } finally { setBusy(false); } }
  async function inspect(bytes: Uint8Array) { const info = await host.current?.request<PackageInfo>({ kind: 'inspect', bytes }); if (info) setReview({ info, bytes }); }
  async function open(bytes: Uint8Array) { const result = await host.current?.request<Loaded>({ kind: 'load', bytes, consent: true }); if (result) { setLoaded(result); setView(result.view); setReview(null); setStatus(result.storage); const entries = await host.current?.request<LibraryEntry[]>({ kind: 'library' }); if (entries) setLibrary(entries); } }
  async function remove(id: string) { if (!window.confirm('Delete this application and all its local data? Export anything you want to keep first.')) return; await host.current?.request({ kind: 'delete', id }); const entries = await host.current?.request<LibraryEntry[]>({ kind: 'library' }); if (entries) setLibrary(entries); if (loaded?.info.application.id === id) { setLoaded(null); setView(null); } }
  const frame = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${renderer?.hash}'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>${frameStyle}</style></head><body><div id="root"></div><script>${renderer?.code ?? ''}</script></body></html>`;
  return <><header><strong>needware<span aria-hidden="true"> /</span></strong><span>Software when you need it.</span></header><main id="main">
    <div className="intro"><span className="eyebrow">Your software, on your terms</span><h1>What do you need?</h1><p>Small tools for the things you do. Portable applications with their own data and clear permissions.</p>
      <label htmlFor="prompt">Describe your application</label><textarea id="prompt" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Track medicines for my parents, split trip expenses, or plan revision…" />
      <div className="toolbar"><button className="primary" disabled={busy || !prompt.trim()} onClick={() => run(async () => { throw new Error('Model generation is not configured yet. Authored examples and signed package imports work locally.'); })}>Create application</button><button disabled={busy} onClick={() => run(async () => { const bytes = await host.current?.request<Uint8Array>({ kind: 'example' }); if (bytes) await inspect(bytes); })}>Try the authored habit tracker</button><label className="file-label">Import .need<input type="file" accept=".need" onChange={e => { const file = e.target.files?.[0]; if (file) void run(async () => { if (file.size > 32 * 1024 * 1024) throw new Error('Package exceeds 32 MiB.'); await inspect(new Uint8Array(await file.arrayBuffer())); }); }} /></label></div>
      <p className="notice">Under active implementation. The authored example is a real Rust/WASM application, not an AI-generated result. Accounts, generation, and cloud synchronization are still being built.</p>
    </div>
    <div role="status" aria-live="polite">{busy ? 'Verifying application…' : status}</div>{error && <p className="notice error" role="alert">{error}</p>}
    {review && <section className="review" aria-labelledby="review-title"><h2 id="review-title">Review {review.info.application.title}</h2><p>Package integrity and signature verified. Review this signer before trusting the application.</p><code>{review.info.signers.join(', ')}</code><p>Requested permissions:</p><ul>{review.info.application.capabilities.map((cap, i) => <li key={i}>{cap.kind === 'storage' ? `Read${cap.write ? ' and write' : ''} this application's ${cap.collections.join(', ')} data ${cap.synchronized ? 'with synchronization' : 'on this device'}.` : JSON.stringify(cap)}</li>)}</ul><div className="toolbar"><button className="primary" disabled={busy} onClick={() => run(() => open(review.bytes))}>Trust signer and run application</button><button onClick={() => setReview(null)}>Cancel</button></div><details><summary>Inspect application definition</summary><pre>{JSON.stringify(review.info.application, null, 2)}</pre></details></section>}
    {loaded && renderer && <section className="viewer" aria-label="Application viewer"><div className="security-bar"><strong>{loaded.info.application.title}</strong><p>Needware trusted shell · Local application · {loaded.storage}</p><code>Digest {loaded.info.digest}</code><div className="toolbar"><button onClick={() => { const entry = library.find(a => a.id === loaded.info.application.id); if (entry) download(`${entry.title}.need`, new Uint8Array(entry.bytes), 'application/vnd.needware.package'); }}>Export package</button><button onClick={() => run(async () => { const state = await host.current?.request<string>({ kind: 'export-state' }); if (state) download('needware-state.json', state, 'application/json'); })}>Export plaintext data</button><button onClick={() => run(() => remove(loaded.info.application.id))}>Delete local application</button></div></div><iframe ref={iframe} title={`${loaded.info.application.title} application`} sandbox="allow-scripts" srcDoc={frame} /></section>}
    <section aria-labelledby="library-title"><h2 id="library-title">On this device</h2>{library.length ? <div className="library">{library.map(entry => <article className="app-card" key={entry.id}><strong>{entry.title}</strong><p>Signed package · Local data</p><button disabled={busy} onClick={() => run(() => open(entry.bytes))}>Open {entry.title}</button></article>)}</div> : <p>Your applications will appear here after you run them.</p>}</section>
    <footer>Local data stays in this browser. Browser storage can be cleared or evicted; export a copy of anything important. Offline use requires the shell and runtime to finish caching.</footer>
  </main></>;
}
