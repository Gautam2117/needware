'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import canonicalize from 'canonicalize';
import {authClient} from '../../lib/auth-client';
type Price={id:string;amount:number;currency:string;interval:'month';livemode:boolean};
type Billing={configured:boolean;price:Price|null;checkout:{id:string;expires_at:string}|null;account:{status:string;paid_until:string|null;has_customer:boolean}|null;usage:{plan:string;quota:{daily:number;monthly:number;budget:number};resets_at:string}};
export default function BillingPanel(){const {data:session,isPending}=authClient.useSession();return <BillingDetails key={session?.user.id??'signedout'} account={session?.user.id} pending={isPending}/>;}
function BillingDetails({account,pending}:{account?:string;pending:boolean}){
  const [data,setData]=useState<Billing|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[consent,setConsent]=useState(false);const request=useRef<{price:string;id:string}|null>(null);
  const refresh=useCallback(async(signal?:AbortSignal)=>{if(!account)return;const response=await fetch('/api/billing',{cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)}),value=await response.json();if(!response.ok)throw Error(value.message??'Billing unavailable');signal?.throwIfAborted();setData(value);setError('');},[account]);
  useEffect(()=>{const controller=new AbortController();let loading=false;const load=async()=>{if(loading)return;loading=true;try{await refresh(controller.signal);}catch(failure){if(!controller.signal.aborted)setError(String(failure));}finally{loading=false;}};void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},15000);return()=>{controller.abort();clearInterval(timer);};},[refresh]);
  const price=data?.price,formatted=price?new Intl.NumberFormat(undefined,{style:'currency',currency:price.currency}).format(price.amount/100):'';
  async function open(action:'checkout'|'portal'){
    setBusy(true);setError('');try{
      let payload:unknown={action};if(action==='checkout'){if(!consent||!price)throw Error('Review the recurring price before checkout');const key=canonicalize(price)!;if(data?.checkout)request.current={price:key,id:data.checkout.id};else if(request.current?.price!==key)request.current={price:key,id:crypto.randomUUID()};payload={action,id:request.current!.id,price,consent:true};}
      const response=await fetch('/api/billing',{method:'POST',headers:{'Content-Type':'application/json'},body:canonicalize(payload),signal:AbortSignal.timeout(30000)}),result=await response.json();if(!response.ok){if(response.status===409){request.current=null;setConsent(false);await refresh();}throw Error(result.message??'Billing session unavailable');}
      const url=new URL(result.url);if(url.protocol!=='https:'||url.hostname!==(action==='portal'?'billing.stripe.com':'checkout.stripe.com'))throw Error('Billing redirect rejected');window.location.assign(url.toString());
    }catch(failure){setError(String(failure));}finally{setBusy(false);}
  }
  return <><header><strong>needware /</strong><nav aria-label="Needware"><Link href="/generation">Your creations</Link><Link href="/account">Your account</Link><Link href="/">Create application</Link></nav></header><main id="main"><h1>Billing and your plan</h1>
    {!account&&<p>{pending?'Checking your session…':'Sign in with a verified account to review billing.'}</p>}{error&&<p role="alert" className="notice error">{error}</p>}
    {data&&<><section aria-label="Current plan"><h2>{data.usage.plan==='pro'?'Pro':'Free'}</h2><p>{data.usage.quota.daily} creation requests each UTC day · {data.usage.quota.monthly} each calendar month · ${(data.usage.quota.budget/1000000).toFixed(2)} monthly provider-cost ceiling.</p><p>Existing local and imported encrypted applications remain yours when a subscription ends. Paid access requires confirmed current payment state; stale verification returns creation to Free limits.</p>{data.account&&<p>Payment status: {data.account.status.replaceAll('_',' ')}{data.account.paid_until?` · confirmed through ${new Date(data.account.paid_until).toLocaleString()}`:''}. Checkout return alone does not activate paid access.</p>}</section>
      {price?<section aria-label="Pro subscription"><h2>Pro · {formatted} per month</h2>{!price.livemode&&<p className="notice">Stripe test billing. This installation cannot accept a real payment in this mode.</p>}<p>Renewal is automatic until you cancel in the Stripe billing portal. Payment details go directly to Stripe. The subscription price and provider-cost quota are separate amounts.</p><label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/> I reviewed {formatted} every month and automatic renewal until cancellation</label><button disabled={busy||!consent||data.usage.plan==='pro'} onClick={()=>{void open('checkout');}}>Continue to Stripe checkout</button></section>:<p>Billing is not configured. Free creation and your saved applications remain available.</p>}
      {data.configured&&data.account?.has_customer&&<button disabled={busy} onClick={()=>{void open('portal');}}>Manage subscription in Stripe</button>}<button disabled={busy} onClick={()=>{void refresh().catch(failure=>setError(String(failure)));}}>Refresh verified payment state</button>
    </>}
  </main></>;
}
