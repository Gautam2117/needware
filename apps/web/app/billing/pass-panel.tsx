'use client';
import {useRef,useState} from 'react';
import canonicalize from 'canonicalize';
import Script from 'next/script';
import Link from '../offline-link';
import type {Billing} from './panel';
export default function PassBilling({data,refresh}:{data:Billing;refresh:()=>Promise<void>}){
 const [phone,setPhone]=useState(''),[review,setReview]=useState<string|null>(null),[sdk,setSdk]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const intent=useRef<{digest:string;id:string}|null>(null),price=data.price;
 const digest=canonicalize({price,phone})??null,consent=review!==null&&review===digest;
 async function act(checkout:boolean){setBusy(true);setError('');try{
  let payload:unknown={action:'verify'};
  if(checkout){if(!price||price.interval!=='once'||price.amount!==49900||price.currency!=='inr'||!consent||!data.checkout_available||!/^\d{10}$/.test(phone)||!sdk)throw Error('Review the price and mobile number before payment');
   if(intent.current?.digest!==digest)intent.current={digest:digest!,id:data.checkout?.id??crypto.randomUUID()};
   payload={action:'checkout',id:intent.current!.id,price,phone,consent:true};
  }
  const response=await fetch('/api/billing',{method:'POST',headers:{'Content-Type':'application/json'},body:canonicalize(payload),signal:AbortSignal.timeout(30000)}),result=await response.json();
  if(!response.ok){if(response.status===409){intent.current=null;setReview(null);await refresh();}throw Error(result.message??'Payment could not be verified');}
  if(!checkout){await refresh();return;}
  if(result.provider!=='cashfree_once'||result.livemode!==price?.livemode||typeof result.session!=='string'||! /^[A-Za-z0-9_.-]{16,4096}$/.test(result.session)||!window.Cashfree)throw Error('Payment checkout identity rejected');
  const value=await window.Cashfree({mode:result.livemode?'production':'sandbox'}).checkout({paymentSessionId:result.session,redirectTarget:'_self'});
  if(value.error)throw Error(value.error.message??'Checkout unavailable');
 }catch(failure){setError(failure instanceof Error?failure.message:'Payment unavailable');}finally{setBusy(false);}}
 const active=data.usage.plan==='pro';
 return <><header><strong>needware /</strong><nav aria-label="Needware"><Link href="/">Your apps</Link><Link href="/account">Your account</Link><Link href="/pricing">Pricing</Link></nav></header>
 <main id="main" className="billing-page" aria-busy={busy}><h1>Your Pro pass</h1>{error&&<p role="alert" className="notice error">{error}</p>}
 {data.acceptance_qa&&<p role="alert" className="notice">Live payment acceptance test for this account only. ₹499 is a real charge. Hosted creation is still paused; this is not a public launch. Use the seven-day refund process after verification.</p>}
 {data.checkout_available&&<Script src="https://sdk.cashfree.com/js/v3/cashfree.js" onReady={()=>setSdk(true)} onError={()=>setError('Cashfree could not load. Please try later.')}/>}
 <section aria-label="Current access"><h2>{active?'Pro':'Free'}</h2><p>{data.usage.quota.daily} creation requests per UTC day · {data.usage.quota.monthly} per calendar month, subject to service capacity.</p>
 {data.account?.paid_until&&<p>Verified access ends {new Date(data.account.paid_until).toLocaleString()}.</p>}<p>Your saved applications remain yours after Pro ends. Paid access requires fresh payment verification.</p></section>
 <section aria-label="One-time Pro purchase"><h2>₹499 · 30 days</h2><p>One-time payment. <strong>No automatic renewal.</strong> The 30 days start at the confirmed payment time. Buy another pass after expiry.</p>
 {!data.checkout_available&&<p role="status" className="notice">Purchases are paused while payment and creation services finish verification.</p>}{price&&!price.livemode&&<p className="notice">Sandbox checkout: no real payment is accepted.</p>}
 <label>10-digit Indian mobile number<input type="tel" inputMode="numeric" autoComplete="tel-national" pattern="[0-9]{10}" maxLength={10} value={phone} onChange={event=>{setPhone(event.target.value);setReview(null);}}/></label>
 <p>Payment details are handled by Cashfree. <Link href="/refunds">Seven-day refund policy</Link> · <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link>.</p>
 <label><input type="checkbox" checked={consent} onChange={event=>setReview(event.target.checked?digest:null)}/> I reviewed ₹499 for 30 days, no automatic renewal, and the linked policies.</label>
 <button disabled={busy||active||!data.checkout_available||data.usage.creation_hold||!sdk||!consent||!/^\d{10}$/.test(phone)} onClick={()=>{void act(true);}}>{active?'Your Pro pass is active':'Continue to Cashfree'}</button></section>
 <button disabled={busy||!data.account} onClick={()=>{void act(false);}}>Verify payment and access</button><p><a href="mailto:gautam@continuumarc.tech">Payment or refund support</a></p></main></>;
}
