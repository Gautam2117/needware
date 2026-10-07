import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {Pool,PoolClient} from 'pg';
import type {Certificate} from './vault-proof';
import type {ProviderInfo} from '@needware/ir-types/ProviderInfo';
import type {Usage} from '@needware/ir-types/Usage';
import {creationHeld} from './creation-hold.ts';
import {billingEnabled} from './billing-policy.ts';
import {globalGenerationPolicy,reserveGlobalGeneration,reconcileGlobalGeneration} from './generation-global-quota.ts';
export class GenerationFailure extends Error {readonly status:number;constructor(status:number,message:string){super(message);this.status=status;}}
export type GenerationJob={id:string;owner_id:string;prompt:string|null;recipient:Certificate;provider:ProviderInfo;period:string;reservation:string;state:'queued'|'running'|'cancel_requested'|'succeeded'|'failed'|'cancelled';attempts:number;lease_id:string|null;lease_until:Date|null;dispatched_at:Date|null;stage:unknown;usage:Usage|null;failure:string|null;result_metadata:unknown;result_ciphertext:Buffer|null;package_digest:string|null;created_at:Date;finished_at:Date|null};
const limits={free:{daily:3,monthly:20,budget:10000000},pro:{daily:50,monthly:200,budget:100000000}};
const billingAuthority=()=>[Boolean(process.env.STRIPE_SECRET_KEY||process.env.BETTER_AUTH_URL?.startsWith('https:')),process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')??false,process.env.STRIPE_ACCOUNT_ID??'',billingEnabled()];
export async function generationUsage(pool:Pool,owner:string){
  const entitlement=(await pool.query(`SELECT plan,paid_until FROM needware_entitlement WHERE account_id=$1 AND $5::boolean AND plan='pro' AND paid_until>now() AND updated_at>now()-interval '30 minutes' AND (NOT $2::boolean OR EXISTS(SELECT 1 FROM needware_billing_account b WHERE b.account_id=$1 AND b.merchant_id=$4 AND b.livemode=$3 AND b.status='active' AND b.paid_until>now()))`,[owner,...billingAuthority()])).rows[0],plan=entitlement?'pro':'free',quota=limits[plan];
  const result=(await pool.query(`SELECT u.*, (SELECT count(*)::integer FROM needware_generation_job WHERE owner_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS daily_attempts,date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month' AS resets_at
    FROM (SELECT $1::uuid AS account_id,date_trunc('month',now() AT TIME ZONE 'UTC')::date AS period) p LEFT JOIN needware_generation_usage u USING(account_id,period)`,[owner])).rows[0];
  return {plan,quota,creation_hold:await creationHeld(pool,owner),paid_until:entitlement?.paid_until??null,attempts:result.attempts??0,daily_attempts:result.daily_attempts,reserved_microusd:result.reserved_microusd??'0',spent_microusd:result.spent_microusd??'0',input_tokens:result.input_tokens??'0',output_tokens:result.output_tokens??'0',unknown_requests:result.unknown_requests??0,resets_at:result.resets_at};
}
export const generationSummary=(job:GenerationJob)=>({id:job.id,state:job.state,provider:job.provider,stage:job.stage,usage:job.usage,failure:job.failure,created_at:job.created_at,finished_at:job.finished_at,result_expires_at:job.state==='succeeded'&&job.finished_at?new Date(new Date(job.finished_at).getTime()+30*86400000):null,recipient:job.recipient.device.id});
export async function ownerLock(client:PoolClient,owner:string){
  if(!(await client.query('SELECT id FROM auth_user WHERE id=$1 FOR KEY SHARE',[owner])).rowCount)throw new GenerationFailure(404,'Account unavailable');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1743))',[owner]);
}
export async function generationRecipient(client:PoolClient,owner:string,recipient:Certificate){
  const result=await client.query(`SELECT v.context,v.authority,d.certificate FROM needware_account_vault v JOIN needware_vault_device d ON d.account_id=v.account_id
    WHERE v.account_id=$1 AND d.device_id=$2 FOR SHARE OF v,d`,[owner,recipient.device.id]);
  const current=result.rows[0];if(!current||canonicalize(current.certificate)!==canonicalize(recipient)||canonicalize(current.context)!==canonicalize(recipient.context)||!Buffer.from(recipient.authority).equals(current.authority))throw new GenerationFailure(403,'Approve the requesting encryption device before creation');
}
export async function createGenerationJob(pool:Pool,owner:string,id:string,prompt:string,recipient:Certificate,provider:ProviderInfo,reservation:number):Promise<GenerationJob>{
  if(!prompt.trim()||Buffer.byteLength(prompt)>32768||!Number.isSafeInteger(reservation)||reservation<0||reservation>1000000000)throw new GenerationFailure(400,'Invalid generation request');
  const requestDigest=createHash('sha256').update(canonicalize({prompt,recipient,provider})!).digest('hex'),client=await pool.connect();
  try{await client.query('BEGIN');await ownerLock(client,owner);if(await creationHeld(client,owner))throw new GenerationFailure(403,'Creation is paused after operator review; existing applications and cancellation remain available');await generationRecipient(client,owner,recipient);
    const previous=await client.query<GenerationJob&{request_digest:string}>('SELECT * FROM needware_generation_job WHERE id=$1 FOR UPDATE',[id]);
    if(previous.rowCount){if(previous.rows[0].owner_id!==owner||previous.rows[0].request_digest!==requestDigest)throw new GenerationFailure(409,'Creation request identity is already used');await client.query('COMMIT');return previous.rows[0];}
    const entitlement=await client.query(`SELECT plan FROM needware_entitlement WHERE account_id=$1 AND $5::boolean AND plan='pro' AND paid_until>now() AND updated_at>now()-interval '30 minutes' AND (NOT $2::boolean OR EXISTS(SELECT 1 FROM needware_billing_account b WHERE b.account_id=$1 AND b.merchant_id=$4 AND b.livemode=$3 AND b.status='active' AND b.paid_until>now()))`,[owner,...billingAuthority()]),quota=entitlement.rowCount?limits.pro:limits.free;
    const clock=(await client.query(`SELECT date_trunc('month',now() AT TIME ZONE 'UTC')::date AS period,date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day`)).rows[0];
    await client.query('INSERT INTO needware_generation_usage(account_id,period) VALUES($1,$2) ON CONFLICT DO NOTHING',[owner,clock.period]);
    const usage=(await client.query('SELECT * FROM needware_generation_usage WHERE account_id=$1 AND period=$2 FOR UPDATE',[owner,clock.period])).rows[0];
    const active=(await client.query(`SELECT count(*) FILTER(WHERE state IN ('queued','running','cancel_requested'))::integer AS active,count(*) FILTER(WHERE created_at>=$2)::integer AS daily FROM needware_generation_job WHERE owner_id=$1`,[owner,clock.day])).rows[0];
    if(active.active>=2||active.daily>=quota.daily||usage.attempts>=quota.monthly||Number(usage.reserved_microusd)+Number(usage.spent_microusd)+reservation>quota.budget)throw new GenerationFailure(429,'Creation quota reached; review usage or wait for its reset');
    const stored=(await client.query(`SELECT COALESCE(sum(65536+CASE WHEN state IN ('queued','running','cancel_requested') THEN 4194320 ELSE COALESCE(octet_length(result_ciphertext),0) END),0) AS bytes FROM needware_generation_job WHERE owner_id=$1`,[owner])).rows[0];
    if(Number(stored.bytes)+65536+4194320>128*1024*1024)throw new GenerationFailure(429,'Creation result storage is full; import results and wait for their 30-day expiry');
    await client.query('UPDATE needware_generation_usage SET attempts=attempts+1,reserved_microusd=reserved_microusd+$3 WHERE account_id=$1 AND period=$2',[owner,clock.period,reservation]);
    const job=(await client.query<GenerationJob>(`INSERT INTO needware_generation_job(id,owner_id,request_digest,prompt,recipient,provider,period,reservation) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id,owner,requestDigest,prompt,canonicalize(recipient),canonicalize(provider),clock.period,reservation])).rows[0];
    await client.query('COMMIT');return job;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function getGenerationJob(pool:Pool,owner:string,id:string){const result=await pool.query<GenerationJob>('SELECT * FROM needware_generation_job WHERE id=$1 AND owner_id=$2',[id,owner]);if(!result.rowCount)throw new GenerationFailure(404,'Creation unavailable');return result.rows[0];}
export async function pruneGenerationJobs(pool:Pool){
  const owners=(await pool.query(`SELECT DISTINCT owner_id FROM needware_generation_job WHERE state IN ('succeeded','failed','cancelled') AND finished_at<now()-interval '30 days' ORDER BY owner_id LIMIT 16`)).rows;
  for(const {owner_id:owner} of owners){const client=await pool.connect();try{await client.query('BEGIN');await ownerLock(client,owner);
    await client.query(`DELETE FROM needware_generation_job WHERE id IN (SELECT id FROM needware_generation_job WHERE owner_id=$1 AND state IN ('succeeded','failed','cancelled') AND finished_at<now()-interval '30 days' ORDER BY finished_at,id LIMIT 64 FOR UPDATE)`,[owner]);await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');if(!(error instanceof GenerationFailure&&error.status===404))throw error;}finally{client.release();}}
}
export async function cancelGenerationJob(pool:Pool,owner:string,id:string){const client=await pool.connect();
  try{await client.query('BEGIN');await ownerLock(client,owner);const job=(await client.query<GenerationJob>('SELECT * FROM needware_generation_job WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,owner])).rows[0];if(!job)throw new GenerationFailure(404,'Creation unavailable');
    if(job.state==='queued')await settle(client,job,'cancelled',0,null,'CANCELLED',null);
    else if(job.state==='running')await client.query(`UPDATE needware_generation_job SET state='cancel_requested' WHERE id=$1`,[id]);
    await client.query('COMMIT');return await getGenerationJob(pool,owner,id);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
type EncryptedResult={metadata:unknown;ciphertext:Buffer;digest:string};
async function settle(client:PoolClient,job:GenerationJob,state:'succeeded'|'failed'|'cancelled',cost:number,usage:Usage|null,failure:string|null,result:EncryptedResult|null){
  if(!Number.isSafeInteger(cost)||cost<0||cost>Number(job.reservation))throw new GenerationFailure(503,'Generation usage exceeds its reserved ceiling');
  await reconcileGlobalGeneration(client,job.id,usage);
  await client.query(`UPDATE needware_generation_usage SET reserved_microusd=reserved_microusd-$3,spent_microusd=spent_microusd+$4,input_tokens=input_tokens+$5,output_tokens=output_tokens+$6,unknown_requests=unknown_requests+$7 WHERE account_id=$1 AND period=$2`,[job.owner_id,job.period,job.reservation,cost,usage?.input_tokens??0,usage?.output_tokens??0,usage?.unknown_usage_requests??(job.dispatched_at?1:0)]);
  await client.query(`UPDATE needware_generation_job SET state=$2,prompt=NULL,lease_id=NULL,lease_until=NULL,usage=$3,failure=$4,result_metadata=$5,result_ciphertext=$6,package_digest=$7,finished_at=now() WHERE id=$1`,[job.id,state,usage?canonicalize(usage):null,failure,result?canonicalize(result.metadata):null,result?.ciphertext??null,result?.digest??null]);
}
export async function claimGenerationJob(pool:Pool):Promise<GenerationJob|undefined>{
  const candidate=(await pool.query<GenerationJob>(`SELECT * FROM needware_generation_job WHERE state='queued' OR (state IN ('running','cancel_requested') AND lease_until<now()) ORDER BY created_at,id LIMIT 1`)).rows[0];if(!candidate)return;
  const client=await pool.connect();try{await client.query('BEGIN');await ownerLock(client,candidate.owner_id);
    const job=(await client.query<GenerationJob>('SELECT * FROM needware_generation_job WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];if(!job){await client.query('COMMIT');return;}
    if(job.state==='cancel_requested'||job.state==='running'&&job.lease_until&&job.lease_until<new Date()){
      if(job.dispatched_at||job.state==='cancel_requested'||job.attempts>=3){await settle(client,job,job.state==='cancel_requested'?'cancelled':'failed',job.dispatched_at?Number(job.reservation):0,null,job.dispatched_at?'INTERRUPTED_USAGE_UNKNOWN':'CANCELLED',null);await client.query('COMMIT');return;}
      job.state='queued';
    }
    if(job.state!=='queued'){await client.query('COMMIT');return;}
    if(await creationHeld(client,job.owner_id)){await settle(client,job,'failed',0,null,'ACCOUNT_HELD',null);await client.query('COMMIT');return;}
    if(new Date(job.created_at).getTime()<Date.now()-86400000){await settle(client,job,'failed',0,null,'REQUEST_EXPIRED',null);await client.query('COMMIT');return;}
    try{await generationRecipient(client,job.owner_id,job.recipient);}catch{await settle(client,job,'failed',0,null,'DEVICE_CHANGED',null);await client.query('COMMIT');return;}
    const claimed=(await client.query<GenerationJob>(`UPDATE needware_generation_job SET state='running',attempts=attempts+1,lease_id=$2,lease_until=now()+interval '90 seconds' WHERE id=$1 RETURNING *`,[job.id,randomUUID()])).rows[0];await client.query('COMMIT');return claimed;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function dispatchGenerationJob(pool:Pool,job:GenerationJob){const client=await pool.connect();try{await client.query('BEGIN');await ownerLock(client,job.owner_id);if(await creationHeld(client,job.owner_id))throw new GenerationFailure(403,'Creation is paused after operator review');await generationRecipient(client,job.owner_id,job.recipient);
  const current=(await client.query<GenerationJob>(`SELECT * FROM needware_generation_job WHERE id=$1 AND lease_id=$2 AND state='running' AND dispatched_at IS NULL FOR UPDATE`,[job.id,job.lease_id])).rows[0];
  if(!current)throw new GenerationFailure(409,'Creation lease or consent changed');
  const policy=globalGenerationPolicy();if(policy)await reserveGlobalGeneration(client,current,policy);
  const result=await client.query(`UPDATE needware_generation_job SET dispatched_at=now() WHERE id=$1 AND lease_id=$2 AND state='running' AND dispatched_at IS NULL RETURNING id`,[job.id,job.lease_id]);if(!result.rowCount)throw new GenerationFailure(409,'Creation lease or consent changed');await client.query('COMMIT');job.dispatched_at=new Date();
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
export async function finishGenerationJob(pool:Pool,job:GenerationJob,result:EncryptedResult|null,usage:Usage|null,failure:string|null){const client=await pool.connect();try{await client.query('BEGIN');await ownerLock(client,job.owner_id);
  let deviceValid=true;try{await generationRecipient(client,job.owner_id,job.recipient);}catch{deviceValid=false;}
  const current=(await client.query<GenerationJob>('SELECT * FROM needware_generation_job WHERE id=$1 AND lease_id=$2 FOR UPDATE',[job.id,job.lease_id])).rows[0];if(!current){await client.query('COMMIT');return;}
  const cost=usage?Math.max(usage.configured_cost_microusd,usage.conservative_cost_microusd):current.dispatched_at?Number(current.reservation):0;
  const cancelled=current.state==='cancel_requested',accepted=deviceValid&&!cancelled&&result;
  await settle(client,current,accepted?'succeeded':cancelled?'cancelled':'failed',cost,usage,accepted?null:deviceValid?failure??'CANCELLED':'DEVICE_CHANGED',accepted?result:null);await client.query('COMMIT');
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
