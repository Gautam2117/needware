'use client';
import { useEffect, useRef, useState } from 'react';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { Command, LibraryEntry, Loaded, PackageInfo, RevisionReport, WorkerReply } from '../../../packages/browser-host/src/protocol';
import RevisionReview from './revision-review';
import Sandbox from './sandbox';
import type {SandboxHandle} from './draft-recovery';
import { frameDocument } from './frame-document';
import type { ProviderResponse } from '@needware/ir-types/ProviderResponse';
import type { StageEvent } from '@needware/ir-types/StageEvent';
import { createApplication } from '../../../packages/browser-host/src/compiler-client';
import {createHostedApplication,pollHostedApplication,cancelHostedApplication} from '../../../packages/browser-host/src/hosted-compiler-client';
import {authClient} from '../lib/auth-client';
import {registerOfflineShell} from '../lib/offline-shell';
const stageLabels: Record<StageEvent['stage'], string> = { extract_intent: 'Understanding your request', generate_definition: 'Building your application', repair_definition: 'Correcting an invalid definition', validate_definition: 'Checking behavior and permissions', package_verified: 'Ready for your review', cancelled: 'Creation cancelled', failed: 'Creation did not finish' };

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
export default function Workbench() {
  const {data:session}=authClient.useSession();const [hosted,setHosted]=useState(false);
  const hostedJob=useRef<string|null>(null);const pendingCreation=useRef<{key:string;id:string}|null>(null);
  const host = useRef<Host | null>(null);
  const sandbox=useRef<SandboxHandle>(null);
  const cancellation = useRef<AbortController | null>(null);
  const [provider, setProvider] = useState<ProviderResponse['provider']>(null);
  const [sendConsent, setSendConsent] = useState(false); const [generationStage, setGenerationStage] = useState('');
  const [creating, setCreating] = useState(false);
  const [generationEvents, setGenerationEvents] = useState<StageEvent[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]); const [review, setReview] = useState<{ info: PackageInfo; bytes: Uint8Array } | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null); const [view, setView] = useState<ViewNode | null>(null);
  const [revision, setRevision] = useState<RevisionReport | null>(null);
  const [history, setHistory] = useState<LibraryEntry[] | null>(null);
  const [renderer, setRenderer] = useState<{ code: string; hash: string } | null>(null);
  const [remixSource,setRemixSource]=useState<{entry:string;digest:string}|null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [prompt, setPrompt] = useState(''); const [status, setStatus] = useState('Starting local runtime');
  useEffect(() => {
    const client = new Host(); host.current = client;let active=true;
    fetch('/api/providers').then(response => response.json()).then((data: ProviderResponse&{hosted?:boolean}) => {setProvider(data.provider);setHosted(data.hosted===true);}).catch(() => { /* Local applications remain usable when generation is unavailable. */ });
    fetch('/frame.js').then(async response => {
      if (!response.ok) throw new Error('Renderer download failed.');
      const code = (await response.text()).replace(/<\/script/gi, '<\\/script');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
      setRenderer({ code, hash: btoa(String.fromCharCode(...new Uint8Array(digest))) });
    }).catch(error => setError(String(error)));
    client.request<LibraryEntry[]>({ kind: 'library' }).then(entries => { setLibrary(entries); setStatus('Local runtime ready'); }).catch(error => { setError(String(error)); setStatus('Storage unavailable'); });
    const query=new URLSearchParams(window.location.search),entry=query.get('registry'),revision=query.get('revision');
    if(entry&&revision&&/^[0-9a-f-]{36}$/.test(entry)&&/^[0-9a-f]{64}$/.test(revision)){
      fetch(`/api/registry/${entry}?revision=${revision}&download=1`,{cache:'no-store'}).then(async response=>{
        if(!response.ok)throw Error('Shared application is unavailable');const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>4194304)throw Error('Shared package exceeds the publication limit');
        const info=await client.request<PackageInfo>({kind:'inspect',bytes});if(info.digest!==revision)throw Error('Shared revision digest differs from its pinned link');
        if(query.get('remix')==='1'){
          const copy=new Uint8Array(await client.request<Uint8Array>({kind:'remix',bytes,application:crypto.randomUUID(),revision:crypto.randomUUID(),consent:true})),copied=await client.request<PackageInfo>({kind:'inspect',bytes:copy});
          if(active){setReview({info:copied,bytes:copy});setRemixSource({entry,digest:revision});setStatus('Review your independent remix. Existing application data and sharing access are not copied.');}
        }else if(active){setReview({info,bytes});setRemixSource(null);setStatus('Review the shared definition before saving');}
      }).catch(error=>{if(active)setError(String(error));});
    }
    registerOfflineShell().catch(()=>{if(active)setError('Offline shell could not finish caching. Reload while online before disconnecting.');});
    return () => { active=false;cancellation.current?.abort(); client.close(); host.current = null; };
  }, []);
  async function run(operation: () => Promise<void>) { setBusy(true); setError(''); try { await operation(); } catch (error) { setError(String(error)); } finally { setBusy(false); } }
  async function inspect(bytes: Uint8Array, generated = false) { if (!generated) setGenerationEvents([]); const info = await host.current?.request<PackageInfo>({ kind: 'inspect', bytes }); if (info) { setReview({ info, bytes }); setRevision(null);setRemixSource(null); } }
  async function generate() {
    if(sandbox.current&&!await sandbox.current.confirmLeave())return;
    if (!provider || !sendConsent) throw new Error('Review the generation recipient before continuing.');
    const controller = new AbortController(); cancellation.current = controller; setCreating(true);
    setGenerationEvents([]);
    try {
      if(hosted){
        if(!session?.user.emailVerified)throw Error('Sign in with a verified account and approve this browser encryption device before creating.');
        const key=JSON.stringify([session.user.id,prompt,provider]);if(pendingCreation.current?.key!==key)pendingCreation.current={key,id:crypto.randomUUID()};
        hostedJob.current=pendingCreation.current.id;setGenerationStage('Saving your creation request…');
        const submitted=await createHostedApplication(hostedJob.current,session.user.id,prompt,provider);
        const job=await pollHostedApplication(submitted.id,controller.signal,value=>{setGenerationStage(value.stage?stageLabels[value.stage.stage]??'Creating your application':value.state==='queued'?'Creation queued':'Creating your application');if(value.stage)setGenerationEvents(previous=>[...previous.slice(-11),value.stage!]);});
        pendingCreation.current=null;if(job.state!=='succeeded')throw Error(job.state==='cancelled'?'Creation cancelled.':`Creation did not finish (${job.failure??'unavailable'}). Review Your creations for usage.`);
        const destination=`/encrypted#account=${session.user.id}&job=${job.id}`;
        if(sandbox.current){if(!await sandbox.current.navigate(destination))setStatus('Creation is ready in Your creations. Your unsaved inputs remain here.');}
        else location.assign(destination);return;
      }
      const bytes = await createApplication(prompt, controller.signal, event => { setGenerationStage(stageLabels[event.stage] ?? 'Creating your application'); setGenerationEvents(previous => [...previous.slice(-11), event]); }); await inspect(bytes, true);
    }
    catch (error) { if (controller.signal.aborted) throw new Error('Creation cancelled.'); throw error; }
    finally { cancellation.current = null;hostedJob.current=null; setGenerationStage(''); setCreating(false); }
  }
  async function cancelCreation(){if(hosted&&hostedJob.current){try{await cancelHostedApplication(hostedJob.current);}catch(failure){setError(String(failure));return;}}cancellation.current?.abort();}
  async function show(result: Loaded) { setLoaded(result); setView(result.view); setReview(null); setRevision(null); setHistory(null); setStatus(result.storage); const entries = await host.current?.request<LibraryEntry[]>({ kind: 'library' }); if (entries) setLibrary(entries); }
  async function open(bytes: Uint8Array) {
    if(sandbox.current&&!await sandbox.current.confirmLeave())return;
    const info = await host.current?.request<PackageInfo>({ kind: 'inspect', bytes });
    const entries = await host.current?.request<LibraryEntry[]>({ kind: 'library' });
    const old = entries?.find(e => e.id === info?.application.id);
    if (old && old.digest !== info?.digest) { const report = await host.current?.request<RevisionReport>({ kind: 'preview-revision', bytes, consent: true }); if (report) setRevision(report); return; }
    const result = await host.current?.request<Loaded>({ kind: 'load', bytes, consent: true }); if (result) await show(result);
  }
  async function activate(destructive: boolean, permissions: boolean) { if (!revision) return;if(sandbox.current&&!await sandbox.current.confirmLeave())return; const result = await host.current?.request<Loaded>({ kind: 'activate-revision', review: revision.review_digest, destructive, permissions }); if (result) await show(result); }
  async function recover(snapshot: LibraryEntry) {
    if(sandbox.current&&!await sandbox.current.confirmLeave())return;
    if (!window.confirm('Restore this package and its saved data? Later data will be replaced; a recovery copy of the current state will be saved.')) return;
    const entries = await host.current?.request<LibraryEntry[]>({ kind: 'library' }); const old = entries?.find(e => e.id === snapshot.id);
    if (!old) throw new Error('Application no longer exists.');
    const result = await host.current?.request<Loaded>({ kind: 'rollback', id: snapshot.id, snapshot: snapshot.generation, expected: old.generation, consent: true }); if (result) await show(result);
  }
  async function remove(id: string) { if(loaded?.info.application.id===id&&sandbox.current&&!await sandbox.current.confirmLeave())return; if (!window.confirm('Delete this application and all its local data? Export anything you want to keep first.')) return; await host.current?.request({ kind: 'delete', id }); const entries = await host.current?.request<LibraryEntry[]>({ kind: 'library' }); if (entries) setLibrary(entries); if (loaded?.info.application.id === id) { setLoaded(null); setView(null); } }
  const frame = frameDocument(renderer);
  return <><header><strong>needware<span aria-hidden="true"> /</span></strong><nav aria-label="Needware"><a href="/registry">Application registry</a><a href="/generation">Your creations</a><a href="/encrypted">Your encrypted apps</a><a href="/account">Your account</a></nav></header><main id="main">
    <div className="intro"><span className="eyebrow">Your software, on your terms</span><h1>What do you need?</h1><p>Small tools for the things you do. Portable applications with their own data and clear permissions.</p>
      <label htmlFor="prompt">Describe your application</label><textarea id="prompt" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Track medicines for my parents, split trip expenses, or plan revision…" />
      {provider ? <label><input type="checkbox" checked={sendConsent} onChange={event => setSendConsent(event.target.checked)} /> {provider.fixture ? 'Fixture mode: authored contract-test output. ' : ''}Send my description to {provider.kind} ({provider.model}) at {provider.endpoint}. This installation pays for generation. Local application data is not included.</label> : <p className="notice">Creation is not configured on this installation. You can run an example or import an application.</p>}
      <div className="toolbar"><button className="primary" disabled={busy || !prompt.trim() || !provider || !sendConsent} onClick={() => run(generate)}>Create application</button><button disabled={busy} onClick={() => run(async () => { const bytes = await host.current?.request<Uint8Array>({ kind: 'example' }); if (bytes) await inspect(bytes); })}>Try the authored habit tracker</button><label className="file-label">Import .need<input type="file" accept=".need" onChange={e => { const file = e.target.files?.[0]; if (file) void run(async () => { if (file.size > 32 * 1024 * 1024) throw new Error('Package exceeds 32 MiB.'); await inspect(new Uint8Array(await file.arrayBuffer())); }); }} /></label></div>
      <p className="notice">The authored example is a Rust/WASM application. Configured generation runs through Rust validation and requires signer and permission review before activation.</p>
      {hosted&&provider&&<p className="notice">Hosted creation needs a verified account and an approved encryption device on this browser. Each request reserves up to ${(provider.max_cost_microusd/1000000).toFixed(4)} of your provider-cost quota. Closing this page keeps the job running; recover it in <a href="/generation">Your creations</a>. Descriptions are retained until completion or cancellation. Results can only be opened on the requesting browser until imported into encrypted storage.</p>}
    </div>
    {creating && <button onClick={()=>{void cancelCreation();}}>Cancel creation</button>}
    {!!generationEvents.length && <details><summary>Creation checks</summary><ol>{generationEvents.map((event, index) => <li key={index}>{stageLabels[event.stage] ?? 'Creation event'} · {event.elapsed_ms} ms</li>)}</ol></details>}
    <div role="status" aria-live="polite">{busy ? generationStage || 'Verifying application…' : status}</div>{error && <p className="notice error" role="alert">{error}</p>}
    {revision && <RevisionReview key={revision.review_digest} report={revision} busy={busy} activate={(destructive, permissions) => { void run(() => activate(destructive, permissions)); }} cancel={() => { setRevision(null); setReview(null); }} />}
    {review&&remixSource&&<section aria-label="Remix source"><p>This independent definition names source revision <code>{remixSource.digest}</code>. It has its own signer and application identity.</p><div className="toolbar"><button disabled={busy} onClick={()=>download('needware-remix.need',new Uint8Array(review.bytes),'application/vnd.needware.package')}>Download remix definition</button><a href={`/registry?source=${remixSource.entry}&revision=${remixSource.digest}`}>Publish this remix</a></div></section>}
    {history && <section aria-label="Recovery history"><h2>Recovery history</h2><p>Each copy contains its package and data from before activation or rollback.</p>{history.length ? history.map(entry => <article key={entry.generation}><strong>{entry.title}</strong><p>Saved generation {entry.generation} · {entry.digest}</p><button disabled={busy} onClick={() => run(() => recover(entry))}>Restore generation {entry.generation}</button></article>) : <p>No revision recovery copies yet.</p>}</section>}
    {review && !revision && <section className="review" aria-labelledby="review-title"><h2 id="review-title">Review {review.info.application.title}</h2><p>Package integrity and signature verified. Review this signer before trusting the application.</p><code>{review.info.signers.join(', ')}</code><p>Requested permissions:</p><ul>{review.info.application.capabilities.map((cap, i) => <li key={i}>{cap.kind === 'storage' ? `Read${cap.write ? ' and write' : ''} this application's ${cap.collections.join(', ')} data ${cap.synchronized ? 'with synchronization' : 'on this device'}.` : JSON.stringify(cap)}</li>)}</ul><div className="toolbar"><button className="primary" disabled={busy} onClick={() => run(() => open(review.bytes))}>{library.some(e => e.id === review.info.application.id && e.digest !== review.info.digest) ? 'Trust signer and review revision' : 'Trust signer and run application'}</button><button onClick={() => setReview(null)}>Cancel</button></div><details><summary>Inspect application definition</summary><pre>{JSON.stringify(review.info.application, null, 2)}</pre></details></section>}
    {loaded && renderer && <section className="viewer" aria-label="Application viewer"><div className="security-bar"><strong>{loaded.info.application.title}</strong><p>Needware trusted shell · Local application · {loaded.storage}</p><code>Digest {loaded.info.digest}</code><div className="toolbar"><button onClick={() => { const entry = library.find(a => a.id === loaded.info.application.id); if (entry) download(`${entry.title}.need`, new Uint8Array(entry.bytes), 'application/vnd.needware.package'); }}>Export package</button><button onClick={() => run(async () => { const state = await host.current?.request<string>({ kind: 'export-state' }); if (state) download('needware-state.json', state, 'application/json'); })}>Export plaintext data</button><button disabled={busy} onClick={() => run(async () => { const entries = await host.current?.request<LibraryEntry[]>({ kind: 'history', id: loaded.info.application.id }); if (entries) setHistory(entries); })}>Recovery history</button><button onClick={() => run(() => remove(loaded.info.application.id))}>Delete local application</button></div></div><Sandbox ref={sandbox} binding={`local:${loaded.info.application.id}`} digest={loaded.info.digest} key={loaded.instance} title={loaded.info.application.title} document={frame} view={view ?? loaded.view} error={setError} selectPage={async(node,offset)=>{if(!host.current)throw Error('Runtime is unavailable.');setView(await host.current.request<ViewNode>({kind:'select-page',instance:loaded.instance,node,offset}));}} dispatch={async(action, values) => { if(!host.current)throw Error('Runtime is unavailable.');const result=await host.current.request<ViewNode>({ kind: 'dispatch', instance: loaded.instance, action, values });setView(result); }} /></section>}
    <section aria-labelledby="library-title"><h2 id="library-title">On this device</h2>{library.length ? <div className="library">{library.map(entry => <article className="app-card" key={entry.id}><strong>{entry.title}</strong><p>Signed package · Local data</p><button disabled={busy} onClick={() => run(() => open(entry.bytes))}>Open {entry.title}</button></article>)}</div> : <p>Your applications will appear here after you run them.</p>}</section>
    <footer>Local data stays in this browser. Browser storage can be cleared or evicted; export a copy of anything important. Offline use requires the shell and runtime to finish caching.</footer>
  </main></>;
}
