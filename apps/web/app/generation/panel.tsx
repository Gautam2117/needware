'use client';
import {useCallback,useEffect,useState} from 'react';
import Link from '../offline-link';
import {authClient} from '../../lib/auth-client';
import {cancelHostedApplication,type HostedJob} from '../../../../packages/browser-host/src/hosted-compiler-client';
type Usage={plan:string;creation_hold:boolean;quota:{daily:number;monthly:number;budget:number};attempts:number;daily_attempts:number;reserved_microusd:string;spent_microusd:string;input_tokens:string;output_tokens:string;unknown_requests:number;resets_at:string};
const money=(value:string|number)=>`$${(Number(value)/1000000).toFixed(4)}`;
export default function GenerationPanel(){
  const {data:session}=authClient.useSession();return <GenerationHistory key={session?.user.id??'signedout'} account={session?.user.id}/>;
}
function GenerationHistory({account}:{account?:string}){
  const [jobs,setJobs]=useState<HostedJob[]>([]),[usage,setUsage]=useState<Usage|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=useCallback(async(signal?:AbortSignal)=>{if(!account)return;const response=await fetch('/api/generation/jobs',{cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)}),data=await response.json();if(!response.ok)throw Error(data.message??'Creations unavailable');signal?.throwIfAborted();setJobs(data.jobs);setUsage(data.usage);setError('');},[account]);
  useEffect(()=>{const controller=new AbortController();let loading=false;const load=async()=>{if(loading)return;loading=true;try{await refresh(controller.signal);}catch(failure){if(!controller.signal.aborted)setError(String(failure));}finally{loading=false;}};void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},15000);return()=>{controller.abort();clearInterval(timer);};},[refresh]);
  async function cancel(id:string){setBusy(true);try{await cancelHostedApplication(id);await refresh();}catch(failure){setError(String(failure));}finally{setBusy(false);}}
  return <><header><strong>needware /</strong><nav aria-label="Needware"><Link href="/">Create application</Link><Link href="/encrypted">Your encrypted apps</Link><Link href="/account">Your account</Link></nav></header><main id="main"><h1>Your creations</h1>
    <p>Creation continues when you close the page. Descriptions remain on this installation until completion or cancellation and are sent to the provider you reviewed. Results are encrypted to the requesting browser; import them there before relying on another device.</p>
    <p>Queued requests expire after 24 hours without execution. Creation history and encrypted results expire after 30 days. Import anything you want to keep; imported application data is preserved separately.</p>
    {error&&<p role="alert" className="notice error">{error}</p>}
    {usage?.creation_hold&&<p role="alert">Creation and publication are paused after operator review. Existing applications, data exports, cancellation and account deletion remain available. <Link href="/billing">Manage any existing subscription</Link>.</p>}
    {usage&&<section aria-label="Creation usage"><h2>Usage · {usage.plan}</h2><p>{usage.daily_attempts} / {usage.quota.daily} requests today · {usage.attempts} / {usage.quota.monthly} this month. Cancelled requests still count toward request limits.</p><p>Provider cost: {money(usage.spent_microusd)} settled + {money(usage.reserved_microusd)} reserved / {money(usage.quota.budget)} monthly ceiling. This measures provider cost, not a card charge.</p><p>{usage.input_tokens} input tokens · {usage.output_tokens} output tokens. {usage.unknown_requests} interrupted requests have unknown usage; their reviewed ceiling remains charged to the quota to prevent duplicate paid execution.</p><p>Monthly quota resets {new Date(usage.resets_at).toLocaleString()}.</p></section>}
    <section aria-label="Creation history"><h2>Recent creations</h2>{jobs.length?jobs.map(job=><article className="app-card" key={job.id}><strong>{job.provider.model}</strong><p><code>{job.id}</code> · {job.state.replaceAll('_',' ')} · {new Date(job.created_at).toLocaleString()}</p><p>Requesting browser: <code>{job.recipient}</code></p>{job.stage&&<p>{job.stage.stage.replaceAll('_',' ')}</p>}{job.failure&&<p>Stopped: {job.failure}. Your existing applications are preserved.</p>}{job.usage&&<p>Provider cost {money(Math.max(job.usage.configured_cost_microusd,job.usage.conservative_cost_microusd))}.</p>}
      {job.state==='succeeded'&&account&&<Link href={`/encrypted#account=${account}&job=${job.id}`}>Review encrypted result</Link>}
      {job.result_expires_at&&<p>Import before {new Date(job.result_expires_at).toLocaleString()}.</p>}
      {['queued','running'].includes(job.state)&&<button disabled={busy} onClick={()=>{void cancel(job.id);}}>Cancel creation</button>}
    </article>):<p>No creations yet. Sign in, approve this browser encryption device and describe your first application.</p>}</section><button disabled={busy} onClick={()=>{void refresh().catch(failure=>setError(String(failure)));}}>Refresh creations</button>
  </main></>;
}
