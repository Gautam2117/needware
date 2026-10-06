import canonicalize from 'canonicalize';
import {accountRequest,canonicalBody,cloudFailure,cloudResponse,CloudError} from '../../../lib/cloud-request';
import {authResources} from '../../../lib/auth-options';
import {object,uuid} from '../../../lib/vault-proof';
import {billingConfigured,billingConfig,billingPrice,BillingFailure} from '../../../lib/billing-config';
import {billingSummary,billingCheckout,billingPortal} from '../../../lib/billing-store';
import {generationUsage} from '../../../lib/generation-store';
import {billingEnabled} from '../../../lib/billing-policy';
export const runtime='nodejs';
export async function GET(request:Request){try{const {session,pool}=await accountRequest(request),configured=billingConfigured();
  const [account,usage,price,pending]=await Promise.all([billingEnabled()?billingSummary(pool,session.user.id):null,generationUsage(pool,session.user.id),configured?billingPrice(billingConfig()):null,billingEnabled()?pool.query('SELECT id,expires_at FROM needware_billing_checkout WHERE account_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 1',[session.user.id]):{rows:[]}]);
  return cloudResponse({configured,price,account:account?{status:account.status,paid_until:account.paid_until,has_customer:true}:null,checkout:pending.rows[0]??null,usage});
}catch(error){return error instanceof BillingFailure?cloudResponse({message:error.message},error.status):cloudFailure(error);}}
export async function POST(request:Request){try{const {session,pool}=await accountRequest(request),payload=await canonicalBody(request),action=(payload as {action?:unknown})?.action,config=billingConfig(),{origin}=authResources();
  if(action==='portal'){object(payload,['action']);return cloudResponse({url:await billingPortal(pool,session.user.id,config,origin)});}
  const value=object(payload,['action','id','price','consent']);if(value.action!=='checkout'||value.consent!==true)throw new CloudError(400,'Review recurring billing before checkout');
  if(canonicalize(value.price)!.length>1024)throw new CloudError(400,'Invalid price review');return cloudResponse({url:await billingCheckout(pool,session.user.id,session.user.email,uuid(value.id),value.price,config,origin)});
}catch(error){return error instanceof BillingFailure?cloudResponse({message:error.message},error.status):cloudFailure(error);}}
