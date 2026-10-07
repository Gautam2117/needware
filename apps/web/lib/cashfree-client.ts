import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {BillingFailure} from './billing-config.ts';

export type CashfreeConfig={clientId:string;secret:string;merchant:string;plan:string;amount:number;live:boolean};
type Environment=Record<string,string|undefined>;
const identifier=/^[A-Za-z0-9_-]{1,128}$/;
export function cashfreeConfig(env:Environment=process.env):CashfreeConfig{
  const {CASHFREE_CLIENT_ID:clientId,CASHFREE_CLIENT_SECRET:secret,CASHFREE_MERCHANT_ID:merchant,CASHFREE_PRO_PLAN_ID:plan}=env;
  const mode=env.CASHFREE_ENVIRONMENT,amount=Number(env.CASHFREE_PRO_MONTHLY_PAISE);
  if(env.NEEDWARE_BILLING_MODE!=='cashfree'||!clientId||!secret||!merchant||!plan)throw new BillingFailure(503,'Cashfree billing is not configured');
  if(!identifier.test(clientId)||secret.length<24||secret.length>512||/[\r\n]/.test(secret)||!identifier.test(merchant)||!identifier.test(plan)||!['sandbox','production'].includes(mode??'')||!Number.isSafeInteger(amount)||amount<=0||amount>10000000)throw new BillingFailure(503,'Cashfree billing configuration is invalid');
  if(mode==='production'&&env.CASHFREE_LIVE_APPROVED!=='1')throw new BillingFailure(503,'Cashfree live activation has not been approved');
  return {clientId,secret,merchant,plan,amount,live:mode==='production'};
}

export async function cashfreeRequest(config:CashfreeConfig,path:string,options:{method?:'GET'|'POST';body?:unknown;idempotency?:string}={}){
  if(!/^\/(plans|subscriptions)(\/[A-Za-z0-9_-]{1,128}){0,4}$/.test(path))throw new BillingFailure(503,'Cashfree API path was rejected');
  const method=options.method??'GET';
  if(method==='POST'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.idempotency??''))throw new BillingFailure(503,'Cashfree mutation requires a durable idempotency key');
  const body=options.body===undefined?undefined:JSON.stringify(options.body);
  if((method==='GET'&&body!==undefined)||(body&&Buffer.byteLength(body)>65536))throw new BillingFailure(503,'Cashfree request was rejected');
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(`https://${config.live?'api':'sandbox'}.cashfree.com/pg${path}`,{method,body,redirect:'error',signal:controller.signal,headers:{'content-type':'application/json','x-api-version':'2026-01-01','x-client-id':config.clientId,'x-client-secret':config.secret,...(options.idempotency?{'x-idempotency-key':options.idempotency}:{})}});
    if(!response.ok)throw new BillingFailure(503,'Cashfree is temporarily unavailable');
    if(!response.body||Number(response.headers.get('content-length')??0)>262144)throw new BillingFailure(503,'Cashfree response exceeded its bound');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>262144)throw new BillingFailure(503,'Cashfree response exceeded its bound');chunks.push(chunk.value);}}
    finally{await reader.cancel();}
    const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new BillingFailure(503,'Cashfree response is invalid');
    return value as Record<string,unknown>;
  }catch(error){if(error instanceof BillingFailure)throw error;throw new BillingFailure(503,'Cashfree request could not be verified');}
  finally{clearTimeout(timeout);}
}

export function cashfreeMonthlyPrice(config:CashfreeConfig,plan:Record<string,unknown>){
  if(plan.plan_id!==config.plan||plan.plan_status!=='ACTIVE'||plan.plan_type!=='PERIODIC'||plan.plan_currency!=='INR'||plan.plan_interval_type!=='MONTH'||plan.plan_intervals!==1||typeof plan.plan_recurring_amount!=='number'||!Number.isFinite(plan.plan_recurring_amount)||Math.round(plan.plan_recurring_amount*100)!==config.amount||Math.abs(plan.plan_recurring_amount*100-config.amount)>0.000001)throw new BillingFailure(503,'Approved Cashfree monthly Pro price is unavailable');
  return {id:config.plan,amount:config.amount,currency:'inr',interval:'month' as const,livemode:config.live};
}

const webhookTypes=new Set(['SUBSCRIPTION_STATUS_CHANGED','SUBSCRIPTION_AUTH_STATUS','SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED','SUBSCRIPTION_PAYMENT_SUCCESS','SUBSCRIPTION_PAYMENT_FAILED','SUBSCRIPTION_PAYMENT_CANCELLED','SUBSCRIPTION_REFUND_STATUS','SUBSCRIPTION_CARD_EXPIRY_REMINDER','SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS','SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS']);
export function verifyCashfreeWebhook(config:CashfreeConfig,body:Uint8Array,timestamp:string|null,signature:string|null,now=Date.now()){
  if(body.byteLength===0||body.byteLength>262144||!timestamp||!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>300000||!signature||! /^[A-Za-z0-9+/]{43}=$/.test(signature))throw new BillingFailure(400,'Cashfree webhook signature is invalid');
  const expected=createHmac('sha256',config.secret).update(timestamp).update(body).digest(),actual=Buffer.from(signature,'base64');
  if(actual.length!==expected.length||!timingSafeEqual(expected,actual))throw new BillingFailure(400,'Cashfree webhook signature is invalid');
  let event:unknown;try{event=JSON.parse(Buffer.from(body).toString('utf8'));}catch{throw new BillingFailure(400,'Cashfree webhook body is invalid');}
  if(!event||typeof event!=='object'||Array.isArray(event))throw new BillingFailure(400,'Cashfree webhook body is invalid');
  const value=event as Record<string,unknown>;
  if(typeof value.type!=='string'||!webhookTypes.has(value.type)||typeof value.event_time!=='string'||!Number.isFinite(Date.parse(value.event_time))||!value.data||typeof value.data!=='object'||Array.isArray(value.data))throw new BillingFailure(400,'Cashfree webhook event is unsupported');
  // A verified notification only queues reconciliation. It never proves a paid entitlement.
  const digest=createHash('sha256').update(body).digest('hex');
  const id=createHash('sha256').update(JSON.stringify(['cashfree',config.merchant,config.live,digest])).digest('hex');
  return {id,digest,type:value.type,data:value.data as Record<string,unknown>,eventTime:value.event_time};
}
