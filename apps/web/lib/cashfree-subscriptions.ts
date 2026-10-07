import {createHash} from 'node:crypto';
import {BillingFailure} from './billing-config.ts';
import {cashfreeMonthlyPrice,cashfreeRequest,type CashfreeConfig} from './cashfree-client.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CashfreeSubscriptionIntent={account:string;id:string;email:string;name:string;phone:string;origin:string;firstCharge:string};
export function cashfreeSubscriptionId(config:CashfreeConfig,account:string,id:string){
  if(!uuid.test(account)||!uuid.test(id))throw new BillingFailure(400,'Subscription intent identity is invalid');
  return 'needware_'+createHash('sha256').update(JSON.stringify([config.merchant,config.live,account,id])).digest('hex').slice(0,48);
}
export function cashfreeSubscriptionBody(config:CashfreeConfig,intent:CashfreeSubscriptionIntent){
  const subscription=cashfreeSubscriptionId(config,intent.account,intent.id),origin=new URL(intent.origin);
  if(origin.origin!==intent.origin||origin.username||origin.password||origin.protocol!=='https:'&&!(origin.protocol==='http:'&&!config.live&&['127.0.0.1','localhost'].includes(origin.hostname)))throw new BillingFailure(400,'Subscription return origin is invalid');
  if(!/^[^\s@]{1,128}@[^\s@]{1,128}\.[^\s@]{1,64}$/.test(intent.email)||intent.name.length<2||intent.name.length>80||/[\u0000-\u001f]/.test(intent.name)||!/^\d{10}$/.test(intent.phone)||!Number.isFinite(Date.parse(intent.firstCharge)))throw new BillingFailure(400,'Subscription customer details are invalid');
  return {subscription_id:subscription,customer_details:{customer_email:intent.email,customer_name:intent.name,customer_phone:intent.phone},plan_details:{plan_id:config.plan},authorization_details:{authorization_amount:1,authorization_amount_refund:true},subscription_first_charge_time:intent.firstCharge,subscription_meta:{return_url:`${origin.origin}/billing?provider=cashfree&checkout=returned`},subscription_tags:{needware_account:intent.account,needware_merchant:config.merchant,needware_environment:config.live?'production':'sandbox'}};
}
export function verifyCashfreeSubscription(config:CashfreeConfig,subscription:string,account:string,value:Record<string,unknown>){
  const tags=value.subscription_tags as Record<string,unknown>|undefined,plan=value.plan_details as Record<string,unknown>|undefined;
  if(value.subscription_id!==subscription||typeof value.cf_subscription_id!=='string'||!/^\d{1,40}$/.test(value.cf_subscription_id)||!tags||tags.needware_account!==account||tags.needware_merchant!==config.merchant||tags.needware_environment!==(config.live?'production':'sandbox')||!plan||plan.plan_id!==config.plan||plan.plan_currency!=='INR'||plan.plan_type!=='PERIODIC'||plan.plan_interval_type!=='MONTH'||plan.plan_intervals!==1||typeof plan.plan_recurring_amount!=='number'||Math.abs(plan.plan_recurring_amount*100-config.amount)>0.000001||!Number.isFinite(plan.plan_recurring_amount)||typeof value.subscription_status!=='string'||value.subscription_status.length>80)throw new BillingFailure(503,'Cashfree subscription binding was rejected');
  return {id:subscription,providerId:value.cf_subscription_id,status:value.subscription_status};
}
export async function createCashfreeSubscription(config:CashfreeConfig,intent:CashfreeSubscriptionIntent){
  cashfreeMonthlyPrice(config,await cashfreeRequest(config,`/plans/${config.plan}`));
  const body=cashfreeSubscriptionBody(config,intent),value=await cashfreeRequest(config,'/subscriptions',{method:'POST',body,idempotency:intent.id});
  const bound=verifyCashfreeSubscription(config,body.subscription_id,intent.account,value);
  if(typeof value.subscription_session_id!=='string'||! /^[A-Za-z0-9_.-]{16,4096}$/.test(value.subscription_session_id))throw new BillingFailure(503,'Cashfree checkout session was rejected');
  return {...bound,session:value.subscription_session_id};
}
export async function fetchCashfreeSubscription(config:CashfreeConfig,subscription:string,account:string){
  const value=await cashfreeRequest(config,`/subscriptions/${subscription}`);return verifyCashfreeSubscription(config,subscription,account,value);
}
export async function cancelCashfreeSubscription(config:CashfreeConfig,subscription:string,account:string,idempotency:string){
  const current=await fetchCashfreeSubscription(config,subscription,account);
  if(['CANCELLED','CUSTOMER_CANCELLED'].includes(current.status))return current;
  await cashfreeRequest(config,`/subscriptions/${subscription}/manage`,{method:'POST',body:{subscription_id:subscription,action:'CANCEL'},idempotency});
  const result=await fetchCashfreeSubscription(config,subscription,account);
  if(!['CANCELLED','CUSTOMER_CANCELLED'].includes(result.status))throw new BillingFailure(503,'Cashfree cancellation is not yet confirmed');
  return result;
}
