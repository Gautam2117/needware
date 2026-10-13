import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {Pool} from 'pg';
import {BillingFailure} from './billing-config.ts';
import {ownerLock} from './generation-store.ts';
import {creationHeld} from './creation-hold.ts';
import {cashfreeRequest,cashfreeList,type CashfreeConfig,verifyCashfreeWebhook,CashfreeApiFailure} from './cashfree-client.ts';
import {passDefinition,passCatalog} from './pass-catalog.ts';
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const numeric=(value:unknown)=>typeof value==='string'&&/^[0-9]{1,40}$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):null;
export function cashfreePassPrice(config:CashfreeConfig,id:unknown=passCatalog[0].id){
 if(config.amount!==49900)throw new BillingFailure(503,'One-time Pro price unavailable');
 let plan;try{plan=passDefinition(id);}catch{throw new BillingFailure(400,'Unknown Pro pass');}
 return {id:plan.id,amount:plan.amount,currency:'inr',interval:'once' as const,duration_days:plan.duration_days,automatic_renewal:false,livemode:config.live};
}
function checkOrder(order:Record<string,unknown>,orderId:string,customer:string,amount:number){
 const details=order.customer_details as Record<string,unknown>|undefined;
 if(order.order_id!==orderId||!numeric(order.cf_order_id)||order.order_currency!=='INR'||order.order_amount!==amount/100||details?.customer_id!==customer)throw new BillingFailure(503,'Payment order identity rejected');
}
export async function cashfreeOrderCheckout(pool:Pool,account:string,email:string,name:string,phone:string,id:string,review:unknown,config:CashfreeConfig,origin:string){
 const price=cashfreePassPrice(config,(review as {id?:unknown}|null)?.id);
 if(!idPattern.test(id)||canonicalize(price)!==canonicalize(review)||!/^\d{10}$/.test(phone)||!email||name.length>200)throw new BillingFailure(400,'Review the one-time price and contact details');
 const url=new URL(origin);if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!(url.protocol==='https:'||!config.live&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new BillingFailure(503,'Checkout origin rejected');
 const orderId='nw_'+id.replaceAll('-','').toLowerCase(),customer='cf_cus_'+account.replaceAll('-','');
 const digest=createHash('sha256').update(canonicalize({price,email,name,phone})!).digest('hex'),client=await pool.connect();let expires:Date;
 try{await client.query('BEGIN');await ownerLock(client,account);
  if(await creationHeld(client,account))throw new BillingFailure(403,'New purchases are paused after operator review');
  let billing=(await client.query('SELECT * FROM needware_billing_account WHERE account_id=$1 FOR UPDATE',[account])).rows[0];
  if(billing&&(billing.provider!=='cashfree_once'||billing.merchant_id!==config.merchant||billing.livemode!==config.live))throw new BillingFailure(409,'Review the existing billing provider before purchasing');
  const previous=(await client.query('SELECT * FROM needware_cashfree_order WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(previous&&(previous.account_id!==account||previous.request_digest!==digest||previous.merchant_id!==config.merchant||previous.livemode!==config.live))throw new BillingFailure(409,'Checkout identity changed');
  if(previous&&(previous.state!=='pending'||new Date(previous.expires_at)<=new Date()))throw new BillingFailure(409,'This payment request is closed');
  if(billing?.paid_until&&new Date(billing.paid_until)>new Date())throw new BillingFailure(409,'Your Pro pass has not expired; no new payment is needed');
  if(!previous&&(await client.query("SELECT id FROM needware_cashfree_order WHERE account_id=$1 AND state='pending' AND expires_at>now()",[account])).rowCount)throw new BillingFailure(409,'Finish the open checkout or wait for expiry');
  expires=previous?new Date(previous.expires_at):new Date(Date.now()+30*60000);
  if(!billing)billing=(await client.query("INSERT INTO needware_billing_account(account_id,customer_id,merchant_id,livemode,provider) VALUES($1,$2,$3,$4,'cashfree_once') RETURNING *",[account,customer,config.merchant,config.live])).rows[0];
  if(!previous)await client.query('INSERT INTO needware_cashfree_order(id,account_id,merchant_id,livemode,order_id,request_digest,amount,expires_at,plan_id,duration_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,account,config.merchant,config.live,orderId,digest,price.amount,expires,price.id,price.duration_days]);
  await client.query('COMMIT');
  // Exact order/idempotency identity persists before network dispatch. Lost replies resume it.
  let order;try{order=await cashfreeRequest(config,`/orders/${orderId}`);}catch(error){if(!(error instanceof CashfreeApiFailure)||error.apiStatus!==404)throw error;}
  order??=await cashfreeRequest(config,'/orders',{method:'POST',idempotency:id,body:{order_id:orderId,order_amount:price.amount/100,order_currency:'INR',order_expiry_time:expires.toISOString(),customer_details:{customer_id:customer,customer_email:email,customer_name:name,customer_phone:phone},order_meta:{return_url:`${origin.replace(/\/$/,'')}/billing?checkout=returned`,notify_url:`${origin.replace(/\/$/,'')}/api/billing/webhook`},order_note:`Needware Pro: ${price.duration_days} days. One-time payment. No automatic renewal.`}});
  checkOrder(order,orderId,customer,price.amount);
  if(order.order_status!=='ACTIVE'||typeof order.payment_session_id!=='string'||! /^[A-Za-z0-9_.-]{16,4096}$/.test(order.payment_session_id)||!Number.isFinite(Date.parse(String(order.order_expiry_time)))||Date.parse(String(order.order_expiry_time))>expires.getTime()+1000||Date.parse(String(order.order_expiry_time))<=Date.now())throw new BillingFailure(409,'Payment order is not available for checkout');
  await client.query('BEGIN');await ownerLock(client,account);
  if(await creationHeld(client,account))throw new BillingFailure(403,'Purchases are paused');
  // The authenticated provider may refresh a checkout token for this same verified order.
  if(!(await client.query("UPDATE needware_cashfree_order SET session_id=$3 WHERE id=$1 AND account_id=$2 AND request_digest=$4 AND state='pending' AND expires_at>now()",[id,account,order.payment_session_id,digest])).rowCount)throw new BillingFailure(409,'Checkout is no longer available');
  await client.query('COMMIT');return {provider:'cashfree_once',session:order.payment_session_id,livemode:config.live};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function verifyCashfreePass(config:CashfreeConfig,orderId:string,customer:string,now=Date.now(),planId:unknown=passCatalog[0].id){
 const price=cashfreePassPrice(config,planId);
 const order=await cashfreeRequest(config,`/orders/${orderId}`);checkOrder(order,orderId,customer,price.amount);
 if(order.order_status!=='PAID')return null;
 const payments=await cashfreeList(config,`/orders/${orderId}/payments`),successful=payments.filter(p=>p.payment_status==='SUCCESS');
 // Multiple successes need operator refund review; never extend access from ambiguous evidence.
 if(successful.length!==1)return null;
 const payment=successful[0],paymentId=numeric(payment.cf_payment_id),start=Date.parse(String(payment.payment_completion_time??payment.payment_time));
 if(!paymentId||payment.order_id!==orderId||payment.payment_currency!=='INR'||payment.payment_amount!==price.amount/100||payment.order_currency!=='INR'||payment.order_amount!==price.amount/100||payment.is_captured!==true||!Number.isFinite(start)||start>now||!Number.isFinite(Date.parse(String(order.order_expiry_time)))||start>Date.parse(String(order.order_expiry_time))||start<Date.parse(String(order.created_at))||!Number.isFinite(Date.parse(String(order.created_at))))return null;
 const [refunds,disputes]=await Promise.all([cashfreeList(config,`/orders/${orderId}/refunds`),cashfreeList(config,`/payments/${paymentId}/disputes`)]);
 if(refunds.some(r=>r.order_id!==orderId||!['FAILED','CANCELLED'].includes(String(r.refund_status))))return null;
 const won=['DISPUTE_MERCHANT_WON','CHARGEBACK_MERCHANT_WON','RETRIEVAL_MERCHANT_WON','PRE_ARBITRATION_MERCHANT_WON','ARBITRATION_MERCHANT_WON'];
 if(disputes.some(d=>{const details=d.order_details as Record<string,unknown>|undefined;return !details||numeric(details.cf_payment_id)!==paymentId||details.order_id!==orderId||details.order_currency!=='INR'||details.order_amount!==price.amount/100||details.payment_currency!=='INR'||details.payment_amount!==price.amount/100||!won.includes(String(d.dispute_status));}))return null;
 return {paymentId,start:new Date(start),until:new Date(start+price.duration_days*86400000)};
}
export async function synchronizeCashfreePass(pool:Pool,account:string,config:CashfreeConfig){
 const client=await pool.connect();
 try{await client.query('BEGIN');await ownerLock(client,account);
  const billing=(await client.query('SELECT * FROM needware_billing_account WHERE account_id=$1 FOR UPDATE',[account])).rows[0];
  if(!billing||billing.provider!=='cashfree_once'||billing.merchant_id!==config.merchant||billing.livemode!==config.live)throw new BillingFailure(409,'Payment authority changed');
  const rows=(await client.query("SELECT * FROM needware_cashfree_order WHERE account_id=$1 AND merchant_id=$2 AND livemode=$3 AND (state='pending' OR paid_until>now()) ORDER BY created_at,id FOR UPDATE",[account,config.merchant,config.live])).rows;
  if(rows.length>8)throw new BillingFailure(503,'Payment review capacity exceeded');
  let until:Date|null=null;
  for(const row of rows){const price=cashfreePassPrice(config,row.plan_id);if(row.amount!==price.amount||row.duration_days!==price.duration_days)throw new BillingFailure(503,'Persisted pass identity rejected');const paid=await verifyCashfreePass(config,row.order_id,billing.customer_id,Date.now(),row.plan_id);
   if(paid&&row.payment_id&&(row.payment_id!==paid.paymentId||new Date(row.paid_start).getTime()!==paid.start.getTime()))throw new BillingFailure(503,'Confirmed payment identity changed');
   const state=paid?'paid':row.paid_start?'revoked':new Date(row.expires_at)<=new Date()?'expired':'pending';
   await client.query('UPDATE needware_cashfree_order SET state=$2,payment_id=COALESCE(payment_id,$3),paid_start=COALESCE(paid_start,$4),paid_until=COALESCE(paid_until,$5),verified_at=now() WHERE id=$1',[row.id,state,paid?.paymentId??null,paid?.start??null,paid?.until??null]);
   if(paid&&paid.until>new Date()&&(!until||paid.until>until))until=paid.until;
  }
  await client.query("UPDATE needware_billing_account SET status=$2,paid_until=$3,updated_at=now() WHERE account_id=$1",[account,until?'active':'free',until]);
  await client.query("INSERT INTO needware_entitlement(account_id,plan,paid_until,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(account_id) DO UPDATE SET plan=excluded.plan,paid_until=excluded.paid_until,updated_at=now()",[account,until?'pro':'free',until]);
  await client.query('COMMIT');return Boolean(until);
 }catch(error){await client.query('ROLLBACK');
  // A failed provider read cannot keep previously confirmed paid authority fresh.
  await pool.query("UPDATE needware_entitlement SET plan='free',paid_until=NULL,updated_at=now() WHERE account_id=$1 AND EXISTS(SELECT 1 FROM needware_billing_account WHERE account_id=$1 AND provider='cashfree_once' AND merchant_id=$2 AND livemode=$3)",[account,config.merchant,config.live]);
  await pool.query("UPDATE needware_billing_account SET status='verification_failed',updated_at=now() WHERE account_id=$1 AND provider='cashfree_once' AND merchant_id=$2 AND livemode=$3",[account,config.merchant,config.live]);throw error;
 }finally{client.release();}
}
export async function enqueueCashfreeOrderEvent(pool:Pool,event:ReturnType<typeof verifyCashfreeWebhook>,config:CashfreeConfig){
 const data=event.data,order=(data.order??data.refund??data.dispute) as Record<string,unknown>|undefined;
 const orderId=order?.order_id??data.order_id;
 if(typeof orderId!=='string'||! /^[A-Za-z0-9_-]{3,45}$/.test(orderId))throw new BillingFailure(400,'Payment event order identity missing');
 const client=await pool.connect();try{await client.query('BEGIN');
  const inserted=await client.query('INSERT INTO needware_cashfree_order_event(id,identity_digest,merchant_id,livemode,order_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id',[event.id,event.digest,config.merchant,config.live,orderId]);
  if(inserted.rowCount){const row=(await client.query('SELECT account_id FROM needware_cashfree_order WHERE order_id=$1 AND merchant_id=$2 AND livemode=$3',[orderId,config.merchant,config.live])).rows[0];
   if(row?.account_id)await client.query("UPDATE needware_entitlement SET plan='free',paid_until=NULL,updated_at=now() WHERE account_id=$1",[row.account_id]);
  }await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function processCashfreeOrderEvent(pool:Pool,config:CashfreeConfig){
 const lease=randomUUID(),job=(await pool.query(`WITH candidate AS(SELECT id FROM needware_cashfree_order_event WHERE merchant_id=$1 AND livemode=$2 AND processed_at IS NULL AND attempts<20 AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE needware_cashfree_order_event SET lease_id=$3,lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE id IN(SELECT id FROM candidate) RETURNING *`,[config.merchant,config.live,lease])).rows[0];
 if(!job)return false;
 try{const row=(await pool.query('SELECT account_id FROM needware_cashfree_order WHERE order_id=$1 AND merchant_id=$2 AND livemode=$3',[job.order_id,config.merchant,config.live])).rows[0];
  if(row?.account_id)await synchronizeCashfreePass(pool,row.account_id,config);
  await pool.query('UPDATE needware_cashfree_order_event SET processed_at=now(),lease_id=NULL,lease_until=NULL,failure=NULL WHERE id=$1 AND lease_id=$2',[job.id,lease]);
 }catch{await pool.query("UPDATE needware_cashfree_order_event SET lease_id=NULL,lease_until=NULL,failure='RECONCILIATION_FAILED',next_attempt_at=now()+interval '60 seconds' WHERE id=$1 AND lease_id=$2",[job.id,lease]);throw new BillingFailure(503,'Payment reconciliation failed; durable retry scheduled');}
 return true;
}
export async function reconcileCashfreePassAccounts(pool:Pool,config:CashfreeConfig){
 const row=(await pool.query("SELECT account_id FROM needware_billing_account WHERE provider='cashfree_once' AND merchant_id=$1 AND livemode=$2 ORDER BY updated_at,account_id LIMIT 1",[config.merchant,config.live])).rows[0];
 if(!row)return 0;await synchronizeCashfreePass(pool,row.account_id,config);return 1;
}
