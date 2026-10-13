import type {Pool,PoolClient} from 'pg';
import {BillingFailure} from './billing-config.ts';
export function creationReady(availability?:{state:string}){return !availability||availability.state==='ready';}
export function paidLaunchLimit(env:Record<string,string|undefined>=process.env){
 const value=env.NEEDWARE_PAID_COHORT_LIMIT??'3';
 if(!/^[1-9][0-9]?$/.test(value)||Number(value)>10)throw new BillingFailure(503,'Paid launch capacity is not configured');
 return Number(value);
}
export async function paidLaunchCapacity(db:Pick<Pool,'query'>,account:string,merchant:string){
 const limit=paidLaunchLimit();
 // Keep paid/refund-review passes reserved until their original expiry. A delayed
 // refund/dispute reconciliation must not silently admit an extra paid customer.
 const row=(await db.query(`SELECT count(DISTINCT account_id)::int AS used,
  COALESCE(bool_or(account_id=$1),false) AS held FROM needware_cashfree_order
  WHERE merchant_id=$2 AND livemode AND (paid_until>now() OR state='pending' AND expires_at>now())`,[account,merchant])).rows[0];
 return {limit,remaining:Math.max(0,limit-row.used),available:row.held||row.used<limit};
}
export async function assertPaidLaunchCapacity(client:PoolClient,account:string,merchant:string){
 await client.query('SELECT pg_advisory_xact_lock(1745,1)');
 if(!(await paidLaunchCapacity(client,account,merchant)).available)throw new BillingFailure(503,'The initial paid pilot is full; new purchases are paused');
}
