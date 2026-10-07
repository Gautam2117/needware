import {createHmac} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cashfreeConfig,cashfreeMonthlyPrice,cashfreeRequest,verifyCashfreeWebhook} from './cashfree-client.ts';

const config={clientId:'test_client',secret:'sandbox-secret-for-fixtures-only',merchant:'continuumarc',plan:'needware_pro_monthly',amount:49900,live:false};
const environment={NEEDWARE_BILLING_MODE:'cashfree',CASHFREE_CLIENT_ID:config.clientId,CASHFREE_CLIENT_SECRET:config.secret,CASHFREE_MERCHANT_ID:config.merchant,CASHFREE_PRO_PLAN_ID:config.plan,CASHFREE_PRO_MONTHLY_PAISE:'49900',CASHFREE_ENVIRONMENT:'sandbox'};
const plan={plan_id:config.plan,plan_status:'ACTIVE',plan_type:'PERIODIC',plan_currency:'INR',plan_interval_type:'MONTH',plan_intervals:1,plan_recurring_amount:499};
const now=1791388200000,timestamp=String(now);
const body=Buffer.from(JSON.stringify({type:'SUBSCRIPTION_PAYMENT_SUCCESS',event_time:new Date(now).toISOString(),data:{subscription_id:'test_subscription'}}));
const sign=(bytes:Uint8Array,time=timestamp,secret=config.secret)=>createHmac('sha256',secret).update(time).update(bytes).digest('base64');
afterEach(()=>vi.unstubAllGlobals());
describe('Cashfree adapter trust boundaries',()=>{
  it('requires explicit mode, credentials, price and live approval',()=>{
    expect(cashfreeConfig(environment)).toEqual(config);
    for(const [key,value] of [['NEEDWARE_BILLING_MODE','disabled'],['CASHFREE_ENVIRONMENT','test'],['CASHFREE_PRO_MONTHLY_PAISE',''],['CASHFREE_PRO_MONTHLY_PAISE','49900.5'],['CASHFREE_CLIENT_SECRET','short'],['CASHFREE_CLIENT_ID','https://attacker.example'],['CASHFREE_MERCHANT_ID','']])expect(()=>cashfreeConfig({...environment,[key]:value})).toThrow();
    expect(()=>cashfreeConfig({...environment,CASHFREE_ENVIRONMENT:'production'})).toThrow(/approved/);
    expect(cashfreeConfig({...environment,CASHFREE_ENVIRONMENT:'production',CASHFREE_LIVE_APPROVED:'1'}).live).toBe(true);
    expect(()=>cashfreeConfig({...environment,CASHFREE_CLIENT_ID:'TEST_existing_sandbox_key',CASHFREE_ENVIRONMENT:'production',CASHFREE_LIVE_APPROVED:'1'})).toThrow(/approved/);
  });
  it('matches the precise approved active INR monthly plan',()=>{
    expect(cashfreeMonthlyPrice(config,plan).amount).toBe(49900);
    for(const [key,value] of [['plan_id','other'],['plan_status','INACTIVE'],['plan_type','ON_DEMAND'],['plan_currency','USD'],['plan_interval_type','WEEK'],['plan_intervals',2],['plan_recurring_amount',499.001],['plan_recurring_amount','499']])expect(()=>cashfreeMonthlyPrice(config,{...plan,[key]:value})).toThrow();
  });
  it('authenticates raw bytes, rejects tampering and stale/future replay, and scopes deduplication',()=>{
    const signature=sign(body),event=verifyCashfreeWebhook(config,body,timestamp,signature,now);
    expect(event.type).toBe('SUBSCRIPTION_PAYMENT_SUCCESS');expect(event).not.toHaveProperty('paid_until');
    for(const args of [[Buffer.concat([body,Buffer.from(' ')]),timestamp,signature,now],[body,timestamp,signature,now+300001],[body,timestamp,signature,now-300001],[body,'not-a-time',signature,now],[body,timestamp,sign(body,timestamp,'other-secret'),now],[body,timestamp,'AAAA',now]] as const)expect(()=>verifyCashfreeWebhook(config,args[0],args[1],args[2],args[3])).toThrow();
    expect(verifyCashfreeWebhook(config,body,timestamp,signature,now).id).toBe(event.id);
    expect(verifyCashfreeWebhook(config,body,String(now+1000),sign(body,String(now+1000)),now).id).toBe(event.id);
    expect(verifyCashfreeWebhook({...config,live:true},body,timestamp,signature,now).id).not.toBe(event.id);
    expect(verifyCashfreeWebhook({...config,merchant:'other'},body,timestamp,signature,now).id).not.toBe(event.id);
    for(const bytes of [Buffer.from('{'),Buffer.from('[]'),Buffer.from(JSON.stringify({type:'unknown',event_time:new Date(now).toISOString(),data:{}})),Buffer.alloc(262145)])expect(()=>verifyCashfreeWebhook(config,bytes,timestamp,sign(bytes),now)).toThrow();
  });
  it('pins API destination/version, refuses unsafe paths, and requires mutation idempotency',async()=>{
    const mock=vi.fn().mockResolvedValue(new Response(JSON.stringify(plan)));vi.stubGlobal('fetch',mock);
    await cashfreeRequest(config,`/plans/${config.plan}`);
    expect(mock.mock.calls[0][0]).toBe(`https://sandbox.cashfree.com/pg/plans/${config.plan}`);
    expect(mock.mock.calls[0][1].redirect).toBe('error');expect(mock.mock.calls[0][1].headers['x-api-version']).toBe('2026-01-01');
    for(const path of ['/subscriptions/../secrets','https://attacker.example','/subscriptions/x?redirect=other','/subscriptions/x%2f..'])await expect(cashfreeRequest(config,path)).rejects.toThrow();
    await expect(cashfreeRequest(config,'/subscriptions',{method:'POST',body:{}})).rejects.toThrow(/idempotency/);
    const idempotency='16c3d3a0-5067-4d9f-8ea9-ef3c660be199';mock.mockResolvedValue(new Response('{}'));
    await cashfreeRequest(config,'/subscriptions',{method:'POST',body:{},idempotency});
    expect(mock.mock.calls.at(-1)?.[1].headers['x-idempotency-key']).toBe(idempotency);
  });
  it('bounds upstream bodies and redacts provider errors',async()=>{
    const mock=vi.fn();vi.stubGlobal('fetch',mock);
    for(const response of [new Response('secret-provider-error',{status:403}),new Response('x'.repeat(262145)),new Response('[]'),new Response('bad JSON')]){
      mock.mockResolvedValueOnce(response);await expect(cashfreeRequest(config,'/subscriptions/example')).rejects.toThrow(/Cashfree/);
    }
  });
});
