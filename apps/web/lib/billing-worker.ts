import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {billingConfig,stripeId,verifyBillingAccount} from './billing-config.ts';
import {synchronizeBilling} from './billing-store.ts';
type Config=ReturnType<typeof billingConfig>;
async function sourceCustomer(config:Config,event:{type:string;object_id:string;customer_id:string|null}){
  if(event.customer_id)return event.customer_id;
  let charge:string|null=null;
  if(event.type.startsWith('charge.dispute.'))charge=stripeId((await config.stripe.disputes.retrieve(event.object_id)).charge);
  else if(event.type.startsWith('radar.early_fraud_warning.'))charge=stripeId((await config.stripe.radar.earlyFraudWarnings.retrieve(event.object_id)).charge);
  if(!charge)return null;return stripeId((await config.stripe.charges.retrieve(charge)).customer);
}
export async function processBillingEvent(pool:Pool,config:Config){
  await verifyBillingAccount(config);
  const lease=randomUUID(),claimed=(await pool.query(`WITH candidate AS (SELECT id FROM needware_billing_event WHERE merchant_id=$3 AND livemode=$2 AND processed_at IS NULL AND attempts<20 AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE needware_billing_event SET lease_id=$1,lease_until=now()+interval '5 minutes',attempts=attempts+1 WHERE id IN(SELECT id FROM candidate) RETURNING *`,[lease,config.live,config.account])).rows[0];if(!claimed)return false;
  const client=await pool.connect();try{await client.query('BEGIN');const current=(await client.query('SELECT id FROM needware_billing_event WHERE id=$1 AND lease_id=$2 FOR UPDATE',[claimed.id,lease])).rows[0];if(!current){await client.query('COMMIT');return true;}
    if(claimed.livemode!==config.live)throw Error('BILLING_MODE_CHANGED');
    const customer=await sourceCustomer(config,claimed),account=customer?(await client.query('SELECT account_id FROM needware_billing_account WHERE customer_id=$1',[customer])).rows[0]?.account_id:null;
    if(account){const actual=await config.stripe.customers.retrieve(customer!);await synchronizeBilling(client,account,config,'deleted' in actual&&actual.deleted===true);}
    await client.query('UPDATE needware_billing_event SET processed_at=now(),lease_id=NULL,lease_until=NULL,failure=NULL WHERE id=$1 AND lease_id=$2',[claimed.id,lease]);await client.query('COMMIT');
  }catch{await client.query('ROLLBACK');await pool.query(`UPDATE needware_billing_event SET lease_id=NULL,lease_until=NULL,next_attempt_at=now()+($3*interval '1 second'),failure='RECONCILIATION_FAILED' WHERE id=$1 AND lease_id=$2`,[claimed.id,lease,Math.min(3600,2**Math.min(claimed.attempts,12))]);console.error('Billing reconciliation failed; durable retry scheduled');}finally{client.release();}return true;
}
export async function processBillingCleanup(pool:Pool,config:Config){
  await verifyBillingAccount(config);
  const lease=randomUUID(),job=(await pool.query(`WITH candidate AS(SELECT customer_id FROM needware_billing_cleanup WHERE merchant_id=$3 AND livemode=$2 AND finished_at IS NULL AND attempts<20 AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE needware_billing_cleanup SET lease_id=$1,lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE customer_id IN(SELECT customer_id FROM candidate) RETURNING *`,[lease,config.live,config.account])).rows[0];if(!job)return false;
  try{if(job.merchant_id!==config.account||job.livemode!==config.live)throw Error('BILLING_AUTHORITY_CHANGED');if((await pool.query('SELECT account_id FROM needware_billing_account WHERE customer_id=$1',[job.customer_id])).rowCount)throw Error('CUSTOMER_STILL_OWNED');
    const deleted=await config.stripe.customers.del(job.customer_id,{idempotencyKey:`needware-delete-${job.customer_id}`});if(!deleted.deleted||deleted.id!==job.customer_id)throw Error('DELETION_NOT_CONFIRMED');
    await pool.query('UPDATE needware_billing_cleanup SET finished_at=now(),lease_id=NULL,lease_until=NULL,failure=NULL WHERE customer_id=$1 AND lease_id=$2',[job.customer_id,lease]);
  }catch(error){
    if(error&&typeof error==='object'&&'code' in error&&error.code==='resource_missing'){await pool.query('UPDATE needware_billing_cleanup SET finished_at=now(),lease_id=NULL,lease_until=NULL,failure=NULL WHERE customer_id=$1 AND lease_id=$2',[job.customer_id,lease]);}
    else{await pool.query(`UPDATE needware_billing_cleanup SET lease_id=NULL,lease_until=NULL,next_attempt_at=now()+($3*interval '1 second'),failure='DELETION_FAILED' WHERE customer_id=$1 AND lease_id=$2`,[job.customer_id,lease,Math.min(3600,2**Math.min(job.attempts,12))]);console.error('Billing deletion failed; durable retry scheduled');}
  }return true;
}
export async function reconcileBillingAccounts(pool:Pool,config:Config){
  await verifyBillingAccount(config);
  const accounts=(await pool.query(`SELECT account_id FROM needware_billing_account WHERE merchant_id=$1 AND livemode=$2 AND updated_at<now()-interval '15 minutes' ORDER BY updated_at LIMIT 16`,[config.account,config.live])).rows;
  for(const {account_id:account} of accounts){const client=await pool.connect();try{await client.query('BEGIN');await synchronizeBilling(client,account,config);await client.query('COMMIT');}catch{await client.query('ROLLBACK');console.error('Billing periodic reconciliation failed; access expires if the snapshot becomes stale');}finally{client.release();}}
  await pool.query(`DELETE FROM needware_billing_event WHERE id IN(SELECT id FROM needware_billing_event WHERE processed_at<now()-interval '30 days' ORDER BY processed_at LIMIT 128 FOR UPDATE SKIP LOCKED)`);
  await pool.query(`DELETE FROM needware_billing_checkout WHERE (account_id,id) IN(SELECT account_id,id FROM needware_billing_checkout WHERE expires_at<now()-interval '30 days' ORDER BY expires_at LIMIT 128 FOR UPDATE SKIP LOCKED)`);
  await pool.query(`DELETE FROM needware_billing_cleanup WHERE customer_id IN(SELECT customer_id FROM needware_billing_cleanup WHERE finished_at<now()-interval '30 days' ORDER BY finished_at LIMIT 128 FOR UPDATE SKIP LOCKED)`);
}
