// A short, single-account live test window; never opens checkout to the public.
export function cashfreePassQa(account:string,env:Record<string,string|undefined>=process.env,now=Date.now()){
 const start=Date.parse(env.CASHFREE_PG_ACCEPTANCE_STARTED_AT??''),until=Date.parse(env.CASHFREE_PG_ACCEPTANCE_UNTIL??'');
 return env.NEEDWARE_BILLING_MODE==='cashfree_once'&&env.CASHFREE_ENVIRONMENT==='production'&&env.CASHFREE_PG_LIVE_APPROVED==='1'
  &&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account)&&account===env.CASHFREE_PG_ACCEPTANCE_ACCOUNT
  &&Number.isFinite(start)&&Number.isFinite(until)&&start<=now&&until>now&&until-start>0&&until-start<=1800000;
}
