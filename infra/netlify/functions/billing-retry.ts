import {authResources} from '../../../apps/web/lib/auth-options';
import {cashfreeConfig} from '../../../apps/web/lib/cashfree-client';
import {scheduledCashfree,probeCashfreeHost} from '../../../apps/web/lib/billing-scheduled';

// The schedule executes the worker directly; no second HTTP function is billed.
export const handler=async()=>{
  const started=Date.now();
  const probeUntil=Date.parse(process.env.NEEDWARE_BILLING_HOST_PROBE_UNTIL??'');
  if(process.env.NEEDWARE_BILLING_HOST_PROBE==='1'&&probeUntil>started&&probeUntil-started<=1800000){
    console.log(JSON.stringify(await probeCashfreeHost(authResources().pool.options)));
    return {statusCode:200,body:'Host probe complete'};
  }
  if(process.env.NEEDWARE_BILLING_DISPATCH_MODE!=='scheduled'||process.env.NEEDWARE_BILLING_MODE!=='cashfree')return {statusCode:200,body:'Disabled'};
  const result=await scheduledCashfree(authResources().pool.options,cashfreeConfig());
  if(!result.ok)throw Error('Billing reconciliation requires durable retry');
  console.log(JSON.stringify({billingTick:'PASS',elapsedMs:Date.now()-started}));
  return {statusCode:200,body:'Complete'};
};
