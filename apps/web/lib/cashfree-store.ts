import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {Pool,PoolClient} from 'pg';
import {BillingFailure} from './billing-config.ts';
import {ownerLock} from './generation-store.ts';
import {creationHeld} from './creation-hold.ts';
import {cashfreeMonthlyPrice,cashfreeRequest,cashfreePayments,cashfreeList,type CashfreeConfig,verifyCashfreeWebhook} from './cashfree-client.ts';
import {createCashfreeSubscription,cashfreeSubscriptionId,cashfreeSubscriptionBody,verifyCashfreeSubscription,cancelCashfreeSubscription} from './cashfree-subscriptions.ts';
type Account={account_id:string;provider:string;merchant_id:string;livemode:boolean;subscription_id:string|null;status:string;paid_until:Date|null};
const terminal=new Set(['CANCELLED','CUSTOMER_CANCELLED','COMPLETED','EXPIRED','LINK_EXPIRED']);
const bound=(row:Account|undefined,config:CashfreeConfig)=>{if(!row||row.provider!=='cashfree'||row.merchant_id!==config.merchant||row.livemode!==config.live)throw new BillingFailure(409,'Existing billing provider or environment requires review');};
export const cashfreePrice=async(config:CashfreeConfig)=>cashfreeMonthlyPrice(config,await cashfreeRequest(config,`/plans/${config.plan}`));
export async function cashfreeCheckout(pool:Pool,account:string,email:string,name:string,phone:string,id:string,review:unknown,config:CashfreeConfig,origin:string){
 const price=await cashfreePrice(config);if(canonicalize(price)!==canonicalize(review))throw new BillingFailure(409,'Review the current subscription price again');
 cashfreeSubscriptionBody(config,{account,id,email,name,phone,origin,firstCharge:new Date(Date.now()+48*3600000).toISOString()});
 const subscription=cashfreeSubscriptionId(config,account,id),digest=createHash('sha256').update(canonicalize({price,email,name,phone})!).digest('hex'),client=await pool.connect();let first:Date;
 try{await client.query('BEGIN');await ownerLock(client,account);if(await creationHeld(client,account))throw new BillingFailure(403,'New subscriptions are paused after operator review');
  let row=(await client.query<Account>('SELECT * FROM needware_billing_account WHERE account_id=$1 FOR UPDATE',[account])).rows[0];
  if(row)bound(row,config);else row=(await client.query<Account>("INSERT INTO needware_billing_account(account_id,customer_id,merchant_id,livemode,provider) VALUES($1,$2,$3,$4,'cashfree') RETURNING *",[account,'cf_cus_'+account.replaceAll('-',''),config.merchant,config.live])).rows[0];
  const previous=(await client.query('SELECT * FROM needware_cashfree_checkout WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(previous&&(previous.account_id!==account||previous.request_digest!==digest||previous.merchant_id!==config.merchant||previous.livemode!==config.live))throw new BillingFailure(409,'Checkout intent changed; review the price and contact details again');
  if(previous&&(row.subscription_id!==subscription||row.status!=='INITIALIZED'))throw new BillingFailure(409,'This checkout is no longer pending; review subscription status');
  if(row.subscription_id&&row.subscription_id!==subscription&&(!terminal.has(row.status)||row.paid_until&&row.paid_until>new Date()))throw new BillingFailure(409,'A subscription already exists; manage it before opening another checkout');
  if(previous&&new Date(previous.expires_at)<=new Date())throw new BillingFailure(409,'Checkout expired; cancel its pending subscription before starting again');
  if(previous?.session_id){await client.query('COMMIT');return {provider:'cashfree',session:previous.session_id,livemode:config.live};}
  first=previous?new Date(previous.first_charge):new Date(Date.now()+48*3600000);
  if(!previous)await client.query('INSERT INTO needware_cashfree_checkout(id,account_id,merchant_id,livemode,request_digest,subscription_id,first_charge,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval \'30 minutes\')',[id,account,config.merchant,config.live,digest,subscription,first]);
  await client.query("UPDATE needware_billing_account SET subscription_id=$2,status='INITIALIZED',paid_until=NULL,updated_at=now() WHERE account_id=$1",[account,subscription]);
  await client.query('COMMIT');
  const created=await createCashfreeSubscription(config,{account,id,email,name,phone,origin,firstCharge:first.toISOString()});
  await client.query('BEGIN');await ownerLock(client,account);const current=(await client.query<Account>('SELECT * FROM needware_billing_account WHERE account_id=$1 FOR UPDATE',[account])).rows[0];bound(current,config);
  if(!current||current.subscription_id!==created.id||current.status!=='INITIALIZED'||await creationHeld(client,account))throw new BillingFailure(409,'Checkout was superseded; review subscription status');
  if(!(await client.query('UPDATE needware_cashfree_checkout SET session_id=$3 WHERE id=$1 AND account_id=$2 AND request_digest=$4 AND expires_at>now()',[id,account,created.session,digest])).rowCount)throw new BillingFailure(409,'Checkout expired; review subscription status');
  await client.query('COMMIT');return {provider:'cashfree',session:created.session,livemode:config.live};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
const numberId=(value:unknown)=>typeof value==='string'&&/^\d{1,40}$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):null;
export function cashfreeDate(value:unknown){
 if(typeof value!=='string')return NaN;
 const normalized=/^\d{4}-\d\d-\d\d$/.test(value)?value+'T00:00:00+05:30':/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?$/.test(value)?value+'+05:30':value;
 return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(Z|[+-]\d\d:?\d\d)$/.test(normalized)?Date.parse(normalized):NaN;
}
export function cashfreePaidCandidate(config:CashfreeConfig,subscription:Record<string,unknown>,payments:Record<string,unknown>[],now=Date.now()){
 if(!['ACTIVE','CANCELLED','CUSTOMER_CANCELLED'].includes(String(subscription.subscription_status)))return null;
 const successful=payments.filter(p=>p.payment_type==='CHARGE'&&p.payment_status==='SUCCESS').sort((a,b)=>cashfreeDate(b.payment_schedule_date)-cashfreeDate(a.payment_schedule_date));
 const payment=successful[0];if(!payment||payment.subscription_id!==subscription.subscription_id||numberId(payment.cf_subscription_id)!==numberId(subscription.cf_subscription_id)||typeof payment.payment_id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(payment.payment_id)||!numberId(payment.cf_payment_id)||!numberId(payment.cf_order_id)||typeof payment.payment_amount!=='number'||!Number.isFinite(payment.payment_amount)||Math.abs(payment.payment_amount*100-config.amount)>0.000001)return null;
 const start=cashfreeDate(payment.payment_schedule_date),initiated=cashfreeDate(payment.payment_initiated_date);if(!Number.isFinite(start)||!Number.isFinite(initiated)||start>now||initiated>now||start<now-35*86400000)return null;
 // Billing dates are stored in IST. Clamp month ends without adding a free month.
 const ist=new Date(start+19800000),day=ist.getUTCDate();ist.setUTCDate(1);ist.setUTCMonth(ist.getUTCMonth()+1);ist.setUTCDate(Math.min(day,new Date(Date.UTC(ist.getUTCFullYear(),ist.getUTCMonth()+1,0)).getUTCDate()));
 let end=ist.getTime()-19800000;const next=cashfreeDate(subscription.next_schedule_date);if(Number.isFinite(next)&&next>start)end=Math.min(end,next);
 if(end<=now||end>now+35*86400000)return null;return {payment,paidUntil:new Date(end)};
}
async function confirmedPayment(client:PoolClient,config:CashfreeConfig,subscription:Record<string,unknown>,payment:Record<string,unknown>,refunds:{refund_id:string;cf_payment_id:string}[]){
 const current=await cashfreeRequest(config,`/subscriptions/${subscription.subscription_id}/payments/${payment.payment_id}`);
 for(const key of ['cf_payment_id','cf_subscription_id','cf_order_id','cf_txn_id','subscription_id','payment_id','payment_type','payment_status','payment_amount','payment_schedule_date','payment_initiated_date'])if(String(current[key])!==String(payment[key]))return false;
 // All order refunds and payment disputes are checked, including missed webhooks.
 // Subscription cf_payment_id differs from the PG transaction cf_txn_id.
 // Signed PG notices supply a candidate merchant order ID; API data proves it.
 const transaction=numberId(payment.cf_txn_id);if(!transaction)return false;
 const mappings=(await client.query('SELECT DISTINCT pg_order_id FROM needware_cashfree_event WHERE merchant_id=$1 AND livemode=$2 AND pg_payment_id=$3 AND pg_order_id IS NOT NULL',[config.merchant,config.live,transaction])).rows;
 if(mappings.length!==1)return false;
 const order=await cashfreeRequest(config,`/orders/${mappings[0].pg_order_id}`);
 if(numberId(order.cf_order_id)!==numberId(payment.cf_order_id)||order.order_status!=='PAID'||order.order_currency!=='INR'||typeof order.order_id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(order.order_id)||Number(order.order_amount)!==config.amount/100)return false;
 const pgPayment=await cashfreeRequest(config,`/orders/${order.order_id}/payments/${transaction}`);
 if(numberId(pgPayment.cf_payment_id)!==transaction||pgPayment.order_id!==order.order_id||pgPayment.payment_status!=='SUCCESS'||pgPayment.is_captured!==true||pgPayment.payment_currency!=='INR'||pgPayment.order_currency!=='INR'||Number(pgPayment.order_amount)!==config.amount/100||Number(pgPayment.payment_amount)!==config.amount/100)return false;
 const [orderRefunds,disputes]=await Promise.all([cashfreeList(config,`/orders/${order.order_id}/refunds`),cashfreeList(config,`/payments/${transaction}/disputes`)]);
 if(orderRefunds.some(r=>r.order_id!==order.order_id||!['FAILED','CANCELLED'].includes(String(r.refund_status))))return false;
 if(disputes.some(d=>numberId(d.cf_payment_id)!==transaction||!['DISPUTE_MERCHANT_WON','CHARGEBACK_MERCHANT_WON','RETRIEVAL_MERCHANT_WON','PRE_ARBITRATION_MERCHANT_WON','ARBITRATION_MERCHANT_WON'].includes(String(d.dispute_status))))return false;
 if(refunds.length>8)return false;
 for(const reference of refunds){const refund=await cashfreeRequest(config,`/subscriptions/${subscription.subscription_id}/refunds/${reference.refund_id}`);if(refund.refund_id!==reference.refund_id||numberId(refund.cf_payment_id)!==reference.cf_payment_id||!['FAILED','CANCELLED'].includes(String(refund.refund_status)))return false;}
 return true;
}
export async function synchronizeCashfree(client:PoolClient,account:string,config:CashfreeConfig){
 await ownerLock(client,account);const row=(await client.query<Account>('SELECT * FROM needware_billing_account WHERE account_id=$1 FOR UPDATE',[account])).rows[0];if(!row)return;bound(row,config);
 let paid:Date|null=null,status='free';
 if(row.subscription_id){
  await cashfreePrice(config);const subscription=await cashfreeRequest(config,`/subscriptions/${row.subscription_id}`);const identity=verifyCashfreeSubscription(config,row.subscription_id,account,subscription),payments=await cashfreePayments(config,row.subscription_id);status=identity.status;
  for(const payment of payments){const id=numberId(payment.cf_payment_id);if(!id||payment.subscription_id!==row.subscription_id||numberId(payment.cf_subscription_id)!==identity.providerId)throw new BillingFailure(503,'Cashfree payment binding was rejected');
   const result=await client.query('INSERT INTO needware_cashfree_payment(merchant_id,livemode,cf_payment_id,account_id,subscription_id,cf_subscription_id,cf_txn_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING cf_payment_id',[config.merchant,config.live,id,account,row.subscription_id,identity.providerId,numberId(payment.cf_txn_id)]);
   if(!result.rowCount){const actual=(await client.query('SELECT account_id,subscription_id,cf_subscription_id,cf_txn_id FROM needware_cashfree_payment WHERE merchant_id=$1 AND livemode=$2 AND cf_payment_id=$3 FOR UPDATE',[config.merchant,config.live,id])).rows[0];if(actual?.account_id!==account||actual.subscription_id!==row.subscription_id||actual.cf_subscription_id!==identity.providerId||actual.cf_txn_id&&actual.cf_txn_id!==numberId(payment.cf_txn_id))throw new BillingFailure(503,'Cashfree payment identity changed');await client.query('UPDATE needware_cashfree_payment SET cf_txn_id=COALESCE(cf_txn_id,$4) WHERE merchant_id=$1 AND livemode=$2 AND cf_payment_id=$3',[config.merchant,config.live,id,numberId(payment.cf_txn_id)]);}
  }
  const candidate=cashfreePaidCandidate(config,subscription,payments);
  if(candidate){const refunds=(await client.query('SELECT DISTINCT refund_id,cf_payment_id FROM needware_cashfree_event WHERE merchant_id=$1 AND livemode=$2 AND refund_id IS NOT NULL AND cf_payment_id=$3',[config.merchant,config.live,String(candidate.payment.cf_payment_id)])).rows;
   if(await confirmedPayment(client,config,subscription,candidate.payment,refunds))paid=candidate.paidUntil;else status='payment_review_required';}
  if(status==='ACTIVE'&&!paid)status='payment_review_required';
 }
 await client.query('UPDATE needware_billing_account SET status=$2,paid_until=$3,updated_at=now() WHERE account_id=$1',[account,paid?'active':status,paid]);
 await client.query("INSERT INTO needware_entitlement(account_id,plan,paid_until) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET plan=EXCLUDED.plan,paid_until=EXCLUDED.paid_until,updated_at=now()",[account,paid?'pro':'free',paid]);
}
export async function cashfreeCancel(pool:Pool,account:string,config:CashfreeConfig){
 const client=await pool.connect();try{await client.query('BEGIN');await ownerLock(client,account);const row=(await client.query<Account>('SELECT * FROM needware_billing_account WHERE account_id=$1 FOR UPDATE',[account])).rows[0];if(!row?.subscription_id)throw new BillingFailure(404,'No subscription to cancel');bound(row,config);
  const cancelId=(await client.query('INSERT INTO needware_cashfree_cleanup(merchant_id,livemode,subscription_id,account_id) VALUES($1,$2,$3,$4) ON CONFLICT(merchant_id,livemode,subscription_id) DO UPDATE SET account_id=EXCLUDED.account_id RETURNING cancel_id',[config.merchant,config.live,row.subscription_id,account])).rows[0].cancel_id;
  await client.query('COMMIT');await cancelCashfreeSubscription(config,row.subscription_id,account,cancelId);
  await client.query('BEGIN');await synchronizeCashfree(client,account,config);await client.query('UPDATE needware_cashfree_cleanup SET finished_at=now() WHERE merchant_id=$1 AND livemode=$2 AND subscription_id=$3',[config.merchant,config.live,row.subscription_id]);await client.query('COMMIT');
  return {cancelled:true};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
type Event=ReturnType<typeof verifyCashfreeWebhook>;
export async function enqueueCashfreeEvent(pool:Pool,event:Event,config:CashfreeConfig){
 const data=event.data,details=data.subscription_details as Record<string,unknown>|undefined,payment=data.payment_details as Record<string,unknown>|undefined;
 const reference=(value:unknown,numeric=false)=>{if(value==null)return null;const text=String(value);if(!(numeric?/^\d{1,40}$/:/^[A-Za-z0-9_-]{1,128}$/).test(text))throw new BillingFailure(400,'Cashfree event reference rejected');return text;};
 const gateway=event.type==='PAYMENT_SUCCESS_WEBHOOK',pgData=data.payment as Record<string,unknown>|undefined,pgOrder=data.order as Record<string,unknown>|undefined;
 const subscription=reference(details?.subscription_id??data.subscription_id),cfSubscription=reference(details?.cf_subscription_id??data.cf_subscription_id,true),cfPayment=gateway?null:reference(payment?.cf_payment_id??data.cf_payment_id,true),refund=reference(data.refund_id),pgPayment=gateway?reference(pgData?.cf_payment_id,true):null,pgOrderId=gateway?reference(pgOrder?.order_id):null;
 if(!subscription&&!cfSubscription&&!cfPayment&&!(pgPayment&&pgOrderId))throw new BillingFailure(400,'Cashfree event has no reconciliation reference');
 const client=await pool.connect();try{await client.query('BEGIN');
 const inserted=await client.query('INSERT INTO needware_cashfree_event(id,identity_digest,merchant_id,livemode,type,subscription_id,cf_subscription_id,cf_payment_id,refund_id,pg_order_id,pg_payment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id',[event.id,event.digest,config.merchant,config.live,event.type,subscription,cfSubscription,cfPayment,refund,pgOrderId,pgPayment]);
 // A verified notice suspends stale paid authority until fresh API reconciliation.
 if(inserted.rowCount)await client.query("UPDATE needware_billing_account b SET status='reconciliation_pending',paid_until=NULL WHERE b.provider='cashfree' AND b.merchant_id=$1 AND b.livemode=$2 AND (b.subscription_id=$3 OR EXISTS(SELECT 1 FROM needware_cashfree_payment p WHERE p.account_id=b.account_id AND p.merchant_id=$1 AND p.livemode=$2 AND (p.cf_payment_id=$4 OR p.cf_subscription_id=$5 OR p.cf_txn_id=$6)))",[config.merchant,config.live,subscription,cfPayment,cfSubscription,pgPayment]);
 await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function processCashfreeEvent(pool:Pool,config:CashfreeConfig){
 const lease=randomUUID(),event=(await pool.query("WITH candidate AS(SELECT id FROM needware_cashfree_event WHERE merchant_id=$1 AND livemode=$2 AND processed_at IS NULL AND attempts<20 AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE needware_cashfree_event SET lease_id=$3,lease_until=now()+interval '5 minutes',attempts=attempts+1 WHERE id IN(SELECT id FROM candidate) RETURNING *",[config.merchant,config.live,lease])).rows[0];if(!event)return false;
 const client=await pool.connect();try{await client.query('BEGIN');if(!(await client.query('SELECT id FROM needware_cashfree_event WHERE id=$1 AND lease_id=$2 FOR UPDATE',[event.id,lease])).rowCount){await client.query('COMMIT');return true;}
  let account=event.subscription_id?(await client.query("SELECT account_id FROM needware_billing_account WHERE provider='cashfree' AND merchant_id=$1 AND livemode=$2 AND subscription_id=$3",[config.merchant,config.live,event.subscription_id])).rows[0]?.account_id:null;
  if(!account&&(event.cf_payment_id||event.cf_subscription_id||event.pg_payment_id))account=(await client.query('SELECT account_id FROM needware_cashfree_payment WHERE merchant_id=$1 AND livemode=$2 AND (($3::text IS NOT NULL AND cf_payment_id=$3) OR ($4::text IS NOT NULL AND cf_subscription_id=$4) OR ($5::text IS NOT NULL AND cf_txn_id=$5)) LIMIT 1',[config.merchant,config.live,event.cf_payment_id,event.cf_subscription_id,event.pg_payment_id])).rows[0]?.account_id;
  if(!account)throw Error('CASHFREE_REFERENCE_NOT_BOUND');await synchronizeCashfree(client,account,config);
  await client.query('UPDATE needware_cashfree_event SET processed_at=now(),lease_id=NULL,lease_until=NULL,failure=NULL WHERE id=$1 AND lease_id=$2',[event.id,lease]);await client.query('COMMIT');
 }catch{await client.query('ROLLBACK');await pool.query("UPDATE needware_cashfree_event SET lease_id=NULL,lease_until=NULL,failure='RECONCILIATION_FAILED',next_attempt_at=now()+($3*interval '1 second') WHERE id=$1 AND lease_id=$2",[event.id,lease,Math.min(3600,2**Math.min(event.attempts,12))]);throw new BillingFailure(503,'Cashfree reconciliation requires durable retry');}finally{client.release();}return true;
}
export async function reconcileCashfreeAccounts(pool:Pool,config:CashfreeConfig){
 const rows=(await pool.query("SELECT account_id FROM needware_billing_account WHERE provider='cashfree' AND merchant_id=$1 AND livemode=$2 AND updated_at<now()-interval '15 minutes' ORDER BY updated_at LIMIT 1",[config.merchant,config.live])).rows;
 for(const row of rows){const client=await pool.connect();try{await client.query('BEGIN');await synchronizeCashfree(client,row.account_id,config);await client.query('COMMIT');}catch{await client.query('ROLLBACK');await pool.query("UPDATE needware_billing_account SET status='reconciliation_failed',paid_until=NULL WHERE account_id=$1 AND provider='cashfree' AND merchant_id=$2 AND livemode=$3",[row.account_id,config.merchant,config.live]);throw new BillingFailure(503,'Cashfree periodic reconciliation could not be verified');}finally{client.release();}}
 await pool.query("DELETE FROM needware_cashfree_event WHERE id IN(SELECT id FROM needware_cashfree_event WHERE received_at<now()-interval '90 days' AND (processed_at IS NOT NULL OR attempts=20) ORDER BY received_at LIMIT 128 FOR UPDATE SKIP LOCKED)");
 await pool.query("DELETE FROM needware_cashfree_checkout WHERE id IN(SELECT c.id FROM needware_cashfree_checkout c WHERE c.expires_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM needware_billing_account b WHERE b.subscription_id=c.subscription_id) ORDER BY c.expires_at LIMIT 128 FOR UPDATE SKIP LOCKED)");
 await pool.query("DELETE FROM needware_cashfree_cleanup WHERE (merchant_id,livemode,subscription_id) IN(SELECT merchant_id,livemode,subscription_id FROM needware_cashfree_cleanup WHERE finished_at<now()-interval '30 days' ORDER BY finished_at LIMIT 128 FOR UPDATE SKIP LOCKED)");
 return rows.length;
}
export async function processCashfreeCleanup(pool:Pool,config:CashfreeConfig){
 const lease=randomUUID(),job=(await pool.query("WITH candidate AS(SELECT subscription_id FROM needware_cashfree_cleanup WHERE merchant_id=$1 AND livemode=$2 AND finished_at IS NULL AND attempts<20 AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE needware_cashfree_cleanup SET lease_id=$3,lease_until=now()+interval '5 minutes',attempts=attempts+1 WHERE merchant_id=$1 AND livemode=$2 AND subscription_id IN(SELECT subscription_id FROM candidate) RETURNING *",[config.merchant,config.live,lease])).rows[0];if(!job)return false;
 try{await cancelCashfreeSubscription(config,job.subscription_id,job.account_id,job.cancel_id);const client=await pool.connect();try{await client.query('BEGIN');const row=(await client.query('SELECT subscription_id FROM needware_billing_account WHERE account_id=$1',[job.account_id])).rows[0];if(row?.subscription_id===job.subscription_id)await synchronizeCashfree(client,job.account_id,config);await client.query('UPDATE needware_cashfree_cleanup SET finished_at=now(),lease_id=NULL,lease_until=NULL,failure=NULL WHERE merchant_id=$1 AND livemode=$2 AND subscription_id=$3 AND lease_id=$4',[config.merchant,config.live,job.subscription_id,lease]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
 catch{await pool.query("UPDATE needware_cashfree_cleanup SET lease_id=NULL,lease_until=NULL,failure='CANCELLATION_FAILED',next_attempt_at=now()+($5*interval '1 second') WHERE merchant_id=$1 AND livemode=$2 AND subscription_id=$3 AND lease_id=$4",[config.merchant,config.live,job.subscription_id,lease,Math.min(3600,2**Math.min(job.attempts,12))]);throw new BillingFailure(503,'Cashfree cancellation requires durable retry');}return true;
}
