import {afterEach,describe,expect,it,vi} from 'vitest';
import {cashfreePayments} from './cashfree-client.ts';
import {cashfreeSubscriptionBody,cashfreeSubscriptionId,verifyCashfreeSubscription,cancelCashfreeSubscription} from './cashfree-subscriptions.ts';
const config={clientId:'test_client',secret:'sandbox-secret-for-fixtures-only',merchant:'continuumarc',plan:'needware_pro_monthly',amount:49900,live:false};
const intent={account:'18f3afca-8b1c-4781-9d03-a352f0fd7c7c',id:'16c3d3a0-5067-4d9f-8ea9-ef3c660be199',email:'test@example.com',name:'Sandbox Customer',phone:'9900755700',origin:'https://needware.example',firstCharge:'2026-10-10T12:00:00.000Z'};
const body=cashfreeSubscriptionBody(config,intent),subscription={subscription_id:body.subscription_id,cf_subscription_id:'123456',subscription_status:'INITIALIZED',subscription_tags:body.subscription_tags,plan_details:{plan_id:config.plan,plan_currency:'INR',plan_type:'PERIODIC',plan_interval_type:'MONTH',plan_intervals:1,plan_recurring_amount:499}};
afterEach(()=>vi.unstubAllGlobals());
describe('Cashfree subscription ownership and lifecycle',()=>{
  it('binds deterministic checkout identities to owner, intent, merchant and environment',()=>{
    expect(cashfreeSubscriptionId(config,intent.account,intent.id)).toBe(body.subscription_id);
    for(const other of [{...config,merchant:'other'},{...config,live:true}])expect(cashfreeSubscriptionId(other,intent.account,intent.id)).not.toBe(body.subscription_id);
    expect(body.subscription_tags.needware_account).toBe(intent.account);expect(body.authorization_details.authorization_amount_refund).toBe(true);
    expect(verifyCashfreeSubscription(config,body.subscription_id,intent.account,subscription).status).toBe('INITIALIZED');
  });
  it('rejects another owner, changed plan, merchant, environment and unbound provider response',()=>{
    for(const tags of [{...body.subscription_tags,needware_account:'other'},{...body.subscription_tags,needware_merchant:'other'},{...body.subscription_tags,needware_environment:'production'},null])expect(()=>verifyCashfreeSubscription(config,body.subscription_id,intent.account,{...subscription,subscription_tags:tags})).toThrow(/binding/);
    for(const [key,value] of [['plan_id','other'],['plan_currency','USD'],['plan_type','ON_DEMAND'],['plan_recurring_amount',499.001],['plan_recurring_amount',NaN],['plan_interval_type','WEEK'],['plan_intervals',2]])expect(()=>verifyCashfreeSubscription(config,body.subscription_id,intent.account,{...subscription,plan_details:{...subscription.plan_details,[key]:value}})).toThrow(/binding/);
    expect(()=>verifyCashfreeSubscription(config,'other',intent.account,subscription)).toThrow(/binding/);
    expect(()=>verifyCashfreeSubscription(config,body.subscription_id,intent.account,{...subscription,cf_subscription_id:'invalid'})).toThrow(/binding/);
  });
  it('validates contact fields and canonical return origins before transmission',()=>{
    for(const [key,value] of [['origin','javascript:alert(1)'],['origin','https://attacker@needware.example'],['origin','https://needware.example/path'],['phone','short'],['email','invalid'],['name','X'],['firstCharge','invalid'],['account','not-a-uuid']])expect(()=>cashfreeSubscriptionBody(config,{...intent,[key]:value})).toThrow();
    expect(cashfreeSubscriptionBody(config,{...intent,origin:'http://127.0.0.1:3000'}).subscription_meta.return_url).toContain('127.0.0.1');
    expect(()=>cashfreeSubscriptionBody({...config,live:true},{...intent,origin:'http://127.0.0.1:3000'})).toThrow();
  });
  it('recognizes the real provider null payment list as no evidence and bounds malformed lists',async()=>{
    const mock=vi.fn();vi.stubGlobal('fetch',mock);
    for(const payload of [null,[]]){mock.mockResolvedValueOnce(new Response(JSON.stringify(payload)));expect(await cashfreePayments(config,body.subscription_id)).toEqual([]);}
    for(const payload of [{},[null],['invalid'],Array(1001).fill({})]){mock.mockResolvedValueOnce(new Response(JSON.stringify(payload)));await expect(cashfreePayments(config,body.subscription_id)).rejects.toThrow(/list/);}
  });
  it('confirms cancellation from an authoritative refetch and treats retries as complete',async()=>{
    const cancelled={...subscription,subscription_status:'CANCELLED'},mock=vi.fn();vi.stubGlobal('fetch',mock);
    for(const value of [subscription,{},cancelled,cancelled])mock.mockResolvedValueOnce(new Response(JSON.stringify(value)));
    expect((await cancelCashfreeSubscription(config,body.subscription_id,intent.account,intent.id)).status).toBe('CANCELLED');
    expect(mock.mock.calls[1][1].method).toBe('POST');expect(JSON.parse(mock.mock.calls[1][1].body)).toEqual({subscription_id:body.subscription_id,action:'CANCEL'});
    expect((await cancelCashfreeSubscription(config,body.subscription_id,intent.account,intent.id)).status).toBe('CANCELLED');expect(mock).toHaveBeenCalledTimes(4);
  });
});
