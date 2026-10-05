import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {Pool,PoolClient} from 'pg';
import type Stripe from 'stripe';
import {ownerLock} from './generation-store.ts';
import {creationHeld} from './creation-hold.ts';
import {billingConfig,billingPrice,BillingFailure,stripeId,stripeRedirect,verifyBillingAccount} from './billing-config.ts';
type Config=ReturnType<typeof billingConfig>;
type Account={account_id:string;customer_id:string;merchant_id:string;livemode:boolean;subscription_id:string|null;status:string;paid_until:Date|null};
export async function billingSummary(pool:Pool,account:string){return (await pool.query<Account>('SELECT * FROM needware_billing_account WHERE account_id=$1',[account])).rows[0]??null;}
export async function billingCheckout(pool:Pool,account:string,email:string,id:string,review:unknown,config:Config,origin:string){
  const price=await billingPrice(config);if(canonicalize(price)!==canonicalize(review))throw new BillingFailure(409,'The subscription price changed; review it again');
  const digest=createHash('sha256').update(canonicalize(price)!).digest('hex'),client=await pool.connect();let customer:string|undefined,expires:Date|undefined;
  try{await client.query('BEGIN');await ownerLock(client,account);if(await creationHeld(client,account))throw new BillingFailure(403,'Creation is paused after operator review; manage any existing subscription in the billing portal');
    const previous=(await client.query('SELECT * FROM needware_billing_checkout WHERE account_id=$1 AND id=$2 FOR UPDATE',[account,id])).rows[0];
    if(previous){if(previous.request_digest!==digest)throw new BillingFailure(409,'Checkout request identity changed');if(new Date(previous.expires_at)<new Date())throw new BillingFailure(409,'Checkout expired; review and start another request');expires=new Date(previous.expires_at);}
    let billing=(await client.query<Account>('SELECT * FROM needware_billing_account WHERE account_id=$1 FOR UPDATE',[account])).rows[0];
    if(!billing){const customer=await config.stripe.customers.create({email,metadata:{needware_account:account}},{idempotencyKey:`needware-customer-${account}`});if(customer.livemode!==config.live||!/^cus_[A-Za-z0-9]+$/.test(customer.id))throw new BillingFailure(503,'Billing customer identity rejected');billing=(await client.query<Account>('INSERT INTO needware_billing_account(account_id,customer_id,merchant_id,livemode) VALUES($1,$2,$3,$4) RETURNING *',[account,customer.id,config.account,config.live])).rows[0];}
    if(billing.merchant_id!==config.account||billing.livemode!==config.live)throw new BillingFailure(409,'Billing account or mode changed; review the existing subscription before continuing');
    if(previous?.url){await client.query('COMMIT');return stripeRedirect(previous.url);}
    if(!previous&&(await client.query('SELECT id FROM needware_billing_checkout WHERE account_id=$1 AND expires_at>now()',[account])).rowCount)throw new BillingFailure(409,'A checkout is already open; finish it or wait for its expiry');
    customer=billing.customer_id;expires??=new Date((Math.floor(Date.now()/1000)+1860)*1000);
    if(!previous)await client.query('INSERT INTO needware_billing_checkout(account_id,id,request_digest,expires_at) VALUES($1,$2,$3,$4)',[account,id,digest,expires]);
    await client.query('COMMIT');
    const subscriptions=await config.stripe.subscriptions.list({customer,status:'all',limit:100});
    if(subscriptions.has_more||subscriptions.data.some(sub=>!['canceled','incomplete_expired'].includes(sub.status)))throw new BillingFailure(409,'A subscription already exists; manage it in the billing portal');
    const checkout=await config.stripe.checkout.sessions.create({customer,client_reference_id:account,mode:'subscription',line_items:[{price:config.price,quantity:1}],subscription_data:{metadata:{needware_account:account}},success_url:`${origin}/billing?checkout=returned`,cancel_url:`${origin}/billing?checkout=cancelled`,expires_at:Math.floor(expires.getTime()/1000),allow_promotion_codes:false},{idempotencyKey:`needware-checkout-${account}-${id}`});
    const url=stripeRedirect(checkout.url);if(checkout.livemode!==config.live||stripeId(checkout.customer)!==customer||checkout.mode!=='subscription'||checkout.expires_at!==Math.floor(expires.getTime()/1000))throw new BillingFailure(503,'Checkout identity rejected');
    await client.query('BEGIN');await ownerLock(client,account);if(await creationHeld(client,account))throw new BillingFailure(403,'Creation is paused after operator review');const current=(await client.query('SELECT * FROM needware_billing_checkout WHERE account_id=$1 AND id=$2 FOR UPDATE',[account,id])).rows[0];
    if(!current||current.request_digest!==digest||current.session_id&&current.session_id!==checkout.id)throw new BillingFailure(409,'Checkout intent changed');
    await client.query('UPDATE needware_billing_checkout SET session_id=$3,url=$4 WHERE account_id=$1 AND id=$2',[account,id,checkout.id,url]);await client.query('COMMIT');return url;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function billingPortal(pool:Pool,account:string,config:Config,origin:string){await verifyBillingAccount(config);const client=await pool.connect();try{await client.query('BEGIN');await ownerLock(client,account);const row=(await client.query<Account>('SELECT * FROM needware_billing_account WHERE account_id=$1 FOR SHARE',[account])).rows[0];if(!row)throw new BillingFailure(404,'No billing subscription on this account');if(row.merchant_id!==config.account||row.livemode!==config.live)throw new BillingFailure(409,'Billing account or mode requires review');
  const portal=await config.stripe.billingPortal.sessions.create({customer:row.customer_id,return_url:`${origin}/billing`});const url=stripeRedirect(portal.url,true);await client.query('COMMIT');return url;
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
const eventTypes=new Set(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed','invoice.voided','invoice.marked_uncollectible','customer.deleted','charge.refunded','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','radar.early_fraud_warning.created','radar.early_fraud_warning.updated']);
export async function enqueueBillingEvent(pool:Pool,event:Stripe.Event,live:boolean,merchant:string){
  if(event.livemode!==live)throw new BillingFailure(400,'Billing event mode mismatch');if(!eventTypes.has(event.type))return;
  const object=event.data.object as unknown as {id?:unknown;customer?:string|{id:string}|null};
  if(!/^evt_[A-Za-z0-9]+$/.test(event.id)||typeof object.id!=='string'||!/^[A-Za-z][A-Za-z0-9_]{1,99}$/.test(object.id))throw new BillingFailure(400,'Invalid billing event identity');
  const customer=event.type==='customer.deleted'?object.id:stripeId(object.customer);if(customer&&!/^cus_[A-Za-z0-9]+$/.test(customer))throw new BillingFailure(400,'Invalid billing customer identity');
  const digest=createHash('sha256').update(canonicalize({type:event.type,object:object.id,customer,live,merchant})!).digest('hex');
  const inserted=await pool.query('INSERT INTO needware_billing_event(id,type,object_id,customer_id,identity_digest,livemode,merchant_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id',[event.id,event.type,object.id,customer,digest,live,merchant]);
  if(!inserted.rowCount&&(await pool.query('SELECT identity_digest FROM needware_billing_event WHERE id=$1',[event.id])).rows[0]?.identity_digest!==digest)throw new BillingFailure(409,'Billing event identity changed');
}
async function chargePaid(config:Config,charge:Stripe.Charge,customer:string){
  if(charge.livemode!==config.live||stripeId(charge.customer)!==customer||!charge.paid||charge.status!=='succeeded'||charge.amount_refunded>0||charge.refunded||charge.fraud_details?.stripe_report==='fraudulent'||charge.fraud_details?.user_report==='fraudulent')return false;
  const warnings=await config.stripe.radar.earlyFraudWarnings.list({charge:charge.id,limit:10});if(warnings.has_more||warnings.data.some(warning=>warning.actionable))return false;
  if(charge.disputed){const disputes=await config.stripe.disputes.list({charge:charge.id,limit:10});if(disputes.has_more||!disputes.data.length||disputes.data.some(dispute=>!['won','warning_closed'].includes(dispute.status)))return false;}
  return true;
}
async function paidSubscription(config:Config,subscription:Stripe.Subscription,customer:string){
  if(subscription.status!=='active'||subscription.livemode!==config.live||stripeId(subscription.customer)!==customer||subscription.items.has_more||subscription.items.data.length!==1)return null;
  const item=subscription.items.data[0];if(item.price.id!==config.price||item.quantity!==1||!Number.isSafeInteger(item.current_period_end)||item.current_period_end*1000<=Date.now()||item.current_period_end*1000>Date.now()+40*86400000||!subscription.latest_invoice)return null;
  const invoice=await config.stripe.invoices.retrieve(stripeId(subscription.latest_invoice)!);
  if(invoice.status!=='paid'||invoice.livemode!==config.live||stripeId(invoice.customer)!==customer||stripeId(invoice.parent?.subscription_details?.subscription)!==subscription.id||invoice.amount_remaining!==0)return null;
  if(invoice.currency!==item.price.currency||invoice.lines.has_more||!invoice.lines.data.some(line=>stripeId(line.pricing?.price_details?.price)===config.price&&line.quantity===1&&line.parent?.subscription_item_details?.subscription_item===item.id&&line.period.end>=item.current_period_end))return null;
  const payments=await config.stripe.invoicePayments.list({invoice:invoice.id,status:'paid',limit:4});if(payments.has_more)return null;
  if(invoice.amount_paid>0&&!payments.data.length)return null;
  for(const payment of payments.data){if(stripeId(payment.invoice)!==invoice.id||payment.livemode!==config.live||payment.status!=='paid'||payment.currency!==invoice.currency)return null;
    let charge:Stripe.Charge|undefined;
    if(payment.payment.type==='payment_intent'){const intent=await config.stripe.paymentIntents.retrieve(stripeId(payment.payment.payment_intent)!,{expand:['latest_charge']});if(intent.status!=='succeeded'||intent.livemode!==config.live||stripeId(intent.customer)!==customer||!intent.latest_charge)return null;charge=typeof intent.latest_charge==='string'?await config.stripe.charges.retrieve(intent.latest_charge):intent.latest_charge;}
    else if(payment.payment.type==='charge')charge=await config.stripe.charges.retrieve(stripeId(payment.payment.charge)!);
    else return null;
    if(!await chargePaid(config,charge,customer))return null;
  }
  return new Date(item.current_period_end*1000);
}
export async function synchronizeBilling(client:PoolClient,account:string,config:Config,deleted=false){
  await ownerLock(client,account);const row=(await client.query<Account>('SELECT * FROM needware_billing_account WHERE account_id=$1 FOR UPDATE',[account])).rows[0];if(!row)return;
  if(row.merchant_id!==config.account||row.livemode!==config.live)throw new BillingFailure(409,'Billing authority changed');
  let status=deleted?'deleted':'free',subscription:string|null=null,paid:Date|null=null;
  if(!deleted){const current=await config.stripe.subscriptions.list({customer:row.customer_id,status:'all',limit:100}),active=current.data.filter(value=>!['canceled','incomplete_expired'].includes(value.status));
    if(current.has_more||active.length>1)status='review_required';else if(active.length===1){subscription=active[0].id;paid=await paidSubscription(config,active[0],row.customer_id);status=paid?'active':active[0].status==='active'?'payment_review_required':active[0].status;}
  }
  await client.query('UPDATE needware_billing_account SET subscription_id=$2,status=$3,paid_until=$4,updated_at=now() WHERE account_id=$1',[account,subscription,status,paid]);
  await client.query(`INSERT INTO needware_entitlement(account_id,plan,paid_until) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET plan=EXCLUDED.plan,paid_until=EXCLUDED.paid_until,updated_at=now()`,[account,paid?'pro':'free',paid]);
}
