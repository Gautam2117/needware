import canonicalize from 'canonicalize';
import {accountRequest,canonicalBody,cloudFailure,cloudResponse,CloudError} from '../../../lib/cloud-request';
import {authResources} from '../../../lib/auth-options';
import {object,uuid} from '../../../lib/vault-proof';
import {billingConfigured,billingConfig,billingPrice,BillingFailure} from '../../../lib/billing-config';
import {billingSummary,billingCheckout,billingPortal} from '../../../lib/billing-store';
import {generationUsage} from '../../../lib/generation-store';
import {billingEnabled,billingProvider} from '../../../lib/billing-policy';
import {cashfreeConfig} from '../../../lib/cashfree-client';
import {cashfreePrice,cashfreeCheckout,cashfreeCancel} from '../../../lib/cashfree-store';
import {cashfreePassPrice,cashfreeOrderCheckout,synchronizeCashfreePass} from '../../../lib/cashfree-orders';
import {cashfreePassQa} from '../../../lib/billing-acceptance';
import {passCatalog} from '../../../lib/pass-catalog';
export const runtime='nodejs';
export async function GET(request:Request){try{const {session,pool}=await accountRequest(request),provider=billingProvider();
  if(provider==='cashfree_once'){
    const config=cashfreeConfig(),account=await billingSummary(pool,session.user.id),usage=await generationUsage(pool,session.user.id);
    const checkout=(await pool.query("SELECT id,expires_at,plan_id FROM needware_cashfree_order WHERE account_id=$1 AND state='pending' AND expires_at>now() ORDER BY created_at DESC LIMIT 1",[session.user.id])).rows[0]??null;
    const acceptance_qa=cashfreePassQa(session.user.id);
    const checkout_available=!usage.creation_hold&&(acceptance_qa||process.env.NEEDWARE_HOSTED_GENERATION==='1'&&(!config.live||process.env.CASHFREE_PG_ACCEPTANCE_APPROVED==='1'));
    return cloudResponse({provider,configured:true,checkout_available,acceptance_qa,price:cashfreePassPrice(config),prices:passCatalog.map(plan=>cashfreePassPrice(config,plan.id)),account:account?{status:account.status,paid_until:account.paid_until,has_customer:true}:null,checkout,usage});
  }
  let cashfree;try{if(provider==='cashfree')cashfree=cashfreeConfig();}catch(error){if(!(error instanceof BillingFailure))throw error;}
  const configured=provider==='cashfree'?Boolean(cashfree):billingConfigured();
  const [account,usage,price,pending]=await Promise.all([billingEnabled()?billingSummary(pool,session.user.id):null,generationUsage(pool,session.user.id),configured&&provider==='stripe'?billingPrice(billingConfig()):null,provider==='stripe'?pool.query('SELECT id,expires_at FROM needware_billing_checkout WHERE account_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 1',[session.user.id]):{rows:[]}]);
  let cfPrice=null;try{if(cashfree)cfPrice=await cashfreePrice(cashfree);}catch(error){if(!(error instanceof BillingFailure))throw error;}
  const cfPending=cashfree?(await pool.query('SELECT id,expires_at FROM needware_cashfree_checkout WHERE account_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 1',[session.user.id])).rows[0]:null;
  const checkout_available=configured&&process.env.NEEDWARE_HOSTED_GENERATION==='1'&&!usage.creation_hold&&(provider!=='cashfree'||!cashfree?.live||process.env.CASHFREE_LIVE_ACCEPTANCE_APPROVED==='1');
  return cloudResponse({provider,configured,checkout_available,price:provider==='cashfree'?cfPrice:price,account:account?{status:account.status,paid_until:account.paid_until,has_customer:true}:null,checkout:provider==='cashfree'?cfPending??null:pending.rows[0]??null,usage});
}catch(error){return error instanceof BillingFailure?cloudResponse({message:error.message},error.status):cloudFailure(error);}}
export async function POST(request:Request){try{const {session,pool}=await accountRequest(request),payload=await canonicalBody(request),action=(payload as {action?:unknown})?.action,{origin}=authResources();
  if(billingProvider()==='cashfree_once'){
    const config=cashfreeConfig();
    if(action==='verify'){object(payload,['action']);await synchronizeCashfreePass(pool,session.user.id,config);return cloudResponse({verified:true});}
    if(!cashfreePassQa(session.user.id)&&(config.live&&process.env.CASHFREE_PG_ACCEPTANCE_APPROVED!=='1'||process.env.NEEDWARE_HOSTED_GENERATION!=='1'))throw new BillingFailure(503,'New purchases are paused until payment and creation services are ready');
    const value=object(payload,['action','id','price','consent','phone']);if(value.action!=='checkout'||value.consent!==true||typeof value.phone!=='string')throw new CloudError(400,'Review one-time payment before checkout');
    return cloudResponse(await cashfreeOrderCheckout(pool,session.user.id,session.user.email,session.user.name,value.phone,uuid(value.id),value.price,config,origin));
  }
  if(billingProvider()==='cashfree'){
    const config=cashfreeConfig();
    if(action==='cancel'){const value=object(payload,['action','consent']);if(value.consent!==true)throw new CloudError(400,'Review cancellation before continuing');return cloudResponse(await cashfreeCancel(pool,session.user.id,config));}
    if(config.live&&process.env.CASHFREE_LIVE_ACCEPTANCE_APPROVED!=='1')throw new BillingFailure(503,'New subscriptions are paused until live billing acceptance is approved');
    const value=object(payload,['action','id','price','consent','phone']);if(value.action!=='checkout'||value.consent!==true||typeof value.phone!=='string'||canonicalize(value.price)!.length>1024)throw new CloudError(400,'Review price and contact details before checkout');
    if(process.env.NEEDWARE_HOSTED_GENERATION!=='1')throw new BillingFailure(503,'New subscriptions are paused until hosted creation is ready');
    return cloudResponse(await cashfreeCheckout(pool,session.user.id,session.user.email,session.user.name,value.phone,uuid(value.id),value.price,config,origin));
  }
  const config=billingConfig();
  if(action==='portal'){object(payload,['action']);return cloudResponse({url:await billingPortal(pool,session.user.id,config,origin)});}
  const value=object(payload,['action','id','price','consent']);if(value.action!=='checkout'||value.consent!==true)throw new CloudError(400,'Review recurring billing before checkout');
  if(canonicalize(value.price)!.length>1024)throw new CloudError(400,'Invalid price review');return cloudResponse({url:await billingCheckout(pool,session.user.id,session.user.email,uuid(value.id),value.price,config,origin)});
}catch(error){return error instanceof BillingFailure?cloudResponse({message:error.message},error.status):cloudFailure(error);}}
