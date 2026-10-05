import Stripe from 'stripe';
export class BillingFailure extends Error{readonly status:number;constructor(status:number,message:string){super(message);this.status=status;}}
export function billingConfigured(){return Boolean(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_WEBHOOK_SECRET&&process.env.STRIPE_PRO_PRICE_ID&&process.env.STRIPE_ACCOUNT_ID);}
export function billingConfig(){
  if(!billingConfigured())throw new BillingFailure(503,'Billing is not configured on this installation');
  const key=process.env.STRIPE_SECRET_KEY!,secret=process.env.STRIPE_WEBHOOK_SECRET!,price=process.env.STRIPE_PRO_PRICE_ID!,account=process.env.STRIPE_ACCOUNT_ID!;
  if(!/^sk_(test|live)_[A-Za-z0-9]{24,}$/.test(key)||!/^whsec_[A-Za-z0-9]{24,}$/.test(secret)||!/^price_[A-Za-z0-9]+$/.test(price)||!/^acct_[A-Za-z0-9]+$/.test(account))throw new BillingFailure(503,'Billing configuration is invalid');
  const live=key.startsWith('sk_live_');let fixture:URL|undefined;
  if(process.env.NEEDWARE_BILLING_API_URL){
    fixture=new URL(process.env.NEEDWARE_BILLING_API_URL);const database=process.env.NEEDWARE_ACCEPTANCE_DATABASE,databaseUrl=new URL(process.env.DATABASE_URL!),origin=new URL(process.env.BETTER_AUTH_URL!);
    if(live||process.env.NEEDWARE_BILLING_FIXTURE!=='1'||!database||!/^needware_acceptance_[a-f0-9]{32}$/.test(database)||databaseUrl.pathname!==`/${database}`||!['127.0.0.1','localhost','[::1]'].includes(databaseUrl.hostname)||origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||fixture.protocol!=='http:'||fixture.hostname!=='127.0.0.1'||fixture.pathname!=='/'||fixture.search||fixture.hash||fixture.username||fixture.password)throw new BillingFailure(503,'Billing fixture is restricted to a disposable local acceptance database');
  }
  return {stripe:new Stripe(key,{apiVersion:'2026-09-30.endive',maxNetworkRetries:0,timeout:10000,...(fixture?{host:fixture.hostname,port:Number(fixture.port),protocol:'http' as const}: {})}),secret,price,live,account,fixture:Boolean(fixture)};
}
export async function verifyBillingAccount(config:ReturnType<typeof billingConfig>){if((await config.stripe.accounts.retrieve(null)).id!==config.account)throw new BillingFailure(503,'Stripe account does not match this installation');}
export const stripeId=(value:string|{id:string}|null|undefined)=>typeof value==='string'?value:value?.id??null;
export async function billingPrice(config:ReturnType<typeof billingConfig>){
  await verifyBillingAccount(config);
  const price=await config.stripe.prices.retrieve(config.price);
  if(price.id!==config.price||!price.active||price.livemode!==config.live||price.type!=='recurring'||price.recurring?.interval!=='month'||price.recurring.interval_count!==1||price.billing_scheme!=='per_unit'||price.unit_amount===null||!Number.isSafeInteger(price.unit_amount)||price.unit_amount<=0||!['usd','inr','eur','gbp'].includes(price.currency))throw new BillingFailure(503,'Approved monthly Pro price is unavailable');
  return {id:price.id,amount:price.unit_amount,currency:price.currency,interval:'month' as const,livemode:price.livemode};
}
export function stripeRedirect(value:string|null,portal=false){if(!value)throw new BillingFailure(503,'Billing session unavailable');const url=new URL(value);if(url.protocol!=='https:'||url.hostname!==(portal?'billing.stripe.com':'checkout.stripe.com')||url.username||url.password||value.length>4096)throw new BillingFailure(503,'Billing redirect was rejected');return value;}
