import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareCashfreeLive} from './prepare-cashfree-live.mjs';
const env={CASHFREE_ENVIRONMENT:'production',CASHFREE_LIVE_APPROVED:'1',CASHFREE_CLIENT_ID:'fixture_live_client',CASHFREE_CLIENT_SECRET:'fixture-secret-for-tests-only'};
const plan={plan_id:'needware_pro_monthly_499',plan_status:'ACTIVE',plan_type:'PERIODIC',plan_currency:'INR',plan_recurring_amount:499,plan_intervals:1,plan_interval_type:'MONTH'};
test('preparation requires live approval, never enables billing and only creates the exact missing plan',async()=>{
  const original=globalThis.fetch,requests=[];let exists=false;
  globalThis.fetch=async(url,options)=>{requests.push({url,options});return options.method==='POST'?(exists=true,Response.json(plan)):exists?Response.json(plan):Response.json({code:'plan_not_found'},{status:400});};
  try{
    await assert.rejects(prepareCashfreeLive({...env,CASHFREE_ENVIRONMENT:'sandbox'}));assert.equal(requests.length,0);
    const result=await prepareCashfreeLive(env);assert.equal(result.chargesCreated,0);assert.equal(result.billingActivated,false);
    await prepareCashfreeLive(env);const mutations=requests.filter(row=>row.options.method==='POST');assert.equal(mutations.length,1);
    assert.match(mutations[0].url,/\/pg\/plans$/);assert.equal(JSON.parse(mutations[0].options.body).plan_recurring_amount,499);
    globalThis.fetch=async()=>Response.json({...plan,plan_recurring_amount:999});await assert.rejects(prepareCashfreeLive(env));
  }finally{globalThis.fetch=original;}
});
