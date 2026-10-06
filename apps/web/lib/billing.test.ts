import {afterEach,describe,expect,it,vi} from 'vitest';
import {billingConfig,billingConfigured,stripeRedirect} from './billing-config';
afterEach(()=>vi.unstubAllEnvs());
const database=`needware_acceptance_${'a'.repeat(32)}`;
function fixture(){for(const [key,value] of Object.entries({STRIPE_SECRET_KEY:`sk_test_${'1'.repeat(32)}`,STRIPE_WEBHOOK_SECRET:`whsec_${'2'.repeat(32)}`,STRIPE_PRO_PRICE_ID:'price_fixture',STRIPE_ACCOUNT_ID:'acct_fixture',NEEDWARE_ACCEPTANCE_DATABASE:database,DATABASE_URL:`postgres://127.0.0.1/${database}`,BETTER_AUTH_URL:'http://127.0.0.1:3000',NEEDWARE_BILLING_FIXTURE:'1',NEEDWARE_BILLING_API_URL:'http://127.0.0.1:3030'}))vi.stubEnv(key,value);}
describe('billing external authority boundaries',()=>{
  it('blocks Stripe construction when disabled or misspelled even with retained credentials',()=>{
    fixture();expect(billingConfigured()).toBe(true);
    for(const mode of ['disabled','disable','STRIPE','']){vi.stubEnv('NEEDWARE_BILLING_MODE',mode);expect(billingConfigured()).toBe(false);expect(()=>billingConfig()).toThrow(/not configured/);}
    vi.stubEnv('NEEDWARE_BILLING_MODE','stripe');expect(billingConfig().fixture).toBe(true);
  });
  it('confines authored API fixtures to a named disposable local database and HTTP loopback origin',()=>{
    fixture();expect(billingConfig().fixture).toBe(true);
    for(const [key,value] of [['BETTER_AUTH_URL','https://needware.example'],['DATABASE_URL','postgres://127.0.0.1/needware'],['DATABASE_URL',`postgres://database.example/${database}`],['NEEDWARE_ACCEPTANCE_DATABASE','needware'],['NEEDWARE_BILLING_API_URL','http://attacker.example:3030'],['NEEDWARE_BILLING_API_URL','http://127.0.0.1:3030/path'],['STRIPE_SECRET_KEY',`sk_live_${'1'.repeat(32)}`],['NEEDWARE_BILLING_FIXTURE','0']]){fixture();vi.stubEnv(key,value);expect(()=>billingConfig()).toThrow(/disposable local/);}
  });
  it('rejects checkout and portal phishing destinations and embedded credentials',()=>{
    for(const value of ['http://checkout.stripe.com/pay','https://checkout.stripe.com.attacker.example/pay','https://checkout.stripe.com@attacker.example/pay','https://attacker@checkout.stripe.com/pay','javascript:alert(1)'])expect(()=>stripeRedirect(value)).toThrow();
    expect(stripeRedirect('https://checkout.stripe.com/c/pay/session')).toContain('checkout.stripe.com');expect(()=>stripeRedirect('https://billing.stripe.com/session')).toThrow();expect(stripeRedirect('https://billing.stripe.com/p/session/test',true)).toContain('billing.stripe.com');
  });
});
