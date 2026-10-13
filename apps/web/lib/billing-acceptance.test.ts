import {expect,it} from 'vitest';
import {cashfreePassQa} from './billing-acceptance';
it('live acceptance window is bound to one account, provider approval and absolute thirty-minute lifetime',()=>{
 const owner='10000000-0000-4000-8000-000000000001',now=Date.parse('2026-10-13T06:00:00Z'),env={NEEDWARE_BILLING_MODE:'cashfree_once',CASHFREE_ENVIRONMENT:'production',CASHFREE_PG_LIVE_APPROVED:'1',CASHFREE_PG_ACCEPTANCE_ACCOUNT:owner,CASHFREE_PG_ACCEPTANCE_STARTED_AT:new Date(now).toISOString(),CASHFREE_PG_ACCEPTANCE_UNTIL:new Date(now+1800000).toISOString()};
 expect(cashfreePassQa(owner,env,now)).toBe(true);expect(cashfreePassQa('10000000-0000-4000-8000-000000000002',env,now)).toBe(false);
 for(const patch of [{CASHFREE_PG_LIVE_APPROVED:'0'},{NEEDWARE_BILLING_MODE:'cashfree'},{CASHFREE_ENVIRONMENT:'sandbox'},{CASHFREE_PG_ACCEPTANCE_STARTED_AT:'invalid'},{CASHFREE_PG_ACCEPTANCE_UNTIL:new Date(now+1800001).toISOString()}])expect(cashfreePassQa(owner,{...env,...patch},now)).toBe(false);
 expect(cashfreePassQa(owner,env,now-1)).toBe(false);expect(cashfreePassQa(owner,env,now+1800000)).toBe(false);
});
