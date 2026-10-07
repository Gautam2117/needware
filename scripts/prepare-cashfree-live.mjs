// Server-injected live credentials only. Creates/verifies a plan, never a charge.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {cashfreeConfig,cashfreeRequest,cashfreeMonthlyPrice,CashfreeApiFailure} from '../apps/web/lib/cashfree-client.ts';
export async function prepareCashfreeLive(env=process.env){
  if(env.CASHFREE_ENVIRONMENT!=='production'||env.CASHFREE_LIVE_APPROVED!=='1')throw Error('Merchant and Subscriptions approval plus live credentials are required');
  const merchant='cf_'+createHash('sha256').update(env.CASHFREE_CLIENT_ID??'').digest('hex').slice(0,32);
  const config=cashfreeConfig({...env,NEEDWARE_BILLING_MODE:'cashfree',CASHFREE_MERCHANT_ID:merchant,CASHFREE_PRO_PLAN_ID:env.CASHFREE_PRO_PLAN_ID??'needware_pro_monthly_499',CASHFREE_PRO_MONTHLY_PAISE:'49900'});
  let plan;
  try{plan=await cashfreeRequest(config,`/plans/${config.plan}`);}
  catch(error){
    if(!(error instanceof CashfreeApiFailure)||error.apiStatus!==400||error.code!=='plan_not_found')throw error;
    const bytes=createHash('sha256').update(`needware-plan-v1:${merchant}:${config.plan}:49900`).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=bytes.toString('hex'),idempotency=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    plan=await cashfreeRequest(config,'/plans',{method:'POST',idempotency,body:{plan_id:config.plan,plan_name:'Needware Pro Monthly',plan_type:'PERIODIC',plan_currency:'INR',plan_recurring_amount:499,plan_max_amount:499,plan_intervals:1,plan_interval_type:'MONTH',plan_note:'Needware Pro subscription'}});
  }
  cashfreeMonthlyPrice(config,plan);const price=cashfreeMonthlyPrice(config,await cashfreeRequest(config,`/plans/${config.plan}`));
  return {status:'PASS',environment:'production',merchantNamespace:merchant,plan:price.id,monthlyINR:499,planVerified:true,billingActivated:false,chargesCreated:0};
}
if(import.meta.main||import.meta.url===pathToFileURL(process.argv[1]??'').href){
  try{console.log(JSON.stringify(await prepareCashfreeLive()));}
  catch{console.error('Live plan preparation failed. Verify merchant/Subscriptions activation, live credentials and the exact INR499 monthly plan. No billing activation was performed.');process.exitCode=1;}
}
