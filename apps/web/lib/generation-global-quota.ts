import type {PoolClient} from 'pg';
import type {ProviderInfo} from '@needware/ir-types/ProviderInfo';
import type {Usage} from '@needware/ir-types/Usage';
// Official OSS120b rates, 2026-10-07. Integer neurons round upward per job.
export const neuronRates={input:31818,output:68182};
export type GlobalPolicy={tokens:number;neurons:number;daily:number;accountDaily:number;concurrency:number};
const integer=(value:string|undefined,fallback:number,max:number)=>{const n=value===undefined?fallback:Number(value);if(!/^[1-9][0-9]*$/.test(String(value??fallback))||!Number.isSafeInteger(n)||n>max)throw Error('GLOBAL_GENERATION_POLICY');return n;};
export function globalGenerationPolicy(env:NodeJS.ProcessEnv=process.env):GlobalPolicy|undefined{
  if(!env.NEEDWARE_GENERATION_QUOTA){if(env.NEEDWARE_BILLING_MODE==='disabled'&&env.NEEDWARE_FIXTURE_MODE!=='1')throw Error('GLOBAL_GENERATION_POLICY_REQUIRED');return;}
  if(env.NEEDWARE_GENERATION_QUOTA!=='cloudflare-free'||!['disabled','stripe','cashfree'].includes(env.NEEDWARE_BILLING_MODE??''))throw Error('GLOBAL_GENERATION_POLICY');
  const tokens=integer(env.NEEDWARE_GENERATION_MAX_TOKENS,50000,50000),neurons=Math.ceil(tokens*neuronRates.output/1000000);
  return {tokens,neurons,daily:integer(env.NEEDWARE_GENERATION_DAILY_NEURONS,8000,8000),accountDaily:integer(env.NEEDWARE_GENERATION_ACCOUNT_NEURONS,4000,4000),concurrency:integer(env.NEEDWARE_GENERATION_CONCURRENCY,2,2)};
}
export function assertGlobalProvider(provider:ProviderInfo,env:NodeJS.ProcessEnv=process.env){
  if(provider.fixture&&env.NEEDWARE_FIXTURE_MODE==='1'&&new URL(env.BETTER_AUTH_URL??'').protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(new URL(env.BETTER_AUTH_URL??'').hostname)&&['localhost','127.0.0.1','[::1]'].includes(new URL(env.NEEDWARE_LOCAL_ENDPOINT??'').hostname))return;
  const endpoint=`https://api.cloudflare.com/client/v4/accounts/${env.NEEDWARE_CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`;
  if(provider.fixture||provider.kind!=='local'||provider.model!=='@cf/openai/gpt-oss-120b'||provider.max_cost_microusd!==0||provider.input_microusd_per_million!==0||provider.output_microusd_per_million!==0||provider.endpoint!==env.NEEDWARE_LOCAL_ENDPOINT||provider.endpoint!==endpoint||!/^[0-9a-f]{32}$/.test(env.NEEDWARE_CLOUDFLARE_ACCOUNT_ID??''))throw Error('GLOBAL_GENERATION_PROVIDER');
}
export function knownNeurons(usage:Usage|null,tokens:number):number|undefined{
  if(!usage||usage.unknown_usage_requests!==0||![usage.input_tokens,usage.output_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)||usage.input_tokens+usage.output_tokens>tokens)return;
  return Math.ceil((usage.input_tokens*neuronRates.input+usage.output_tokens*neuronRates.output)/1000000);
}
async function lock(client:PoolClient){await client.query("SELECT pg_advisory_xact_lock(1744,1)");}
type Reservation={job_id:string;account_id:string;days:string[];neurons:number;token_ceiling:number;state:string};
async function charge(client:PoolClient,row:Reservation,neurons:number,unknown:boolean){
  // Reserve the next UTC day too. Unknown/cross-midnight work charges both days.
  await client.query(`UPDATE needware_generation_global_day SET reserved=reserved-$3,spent=spent+CASE WHEN day=$4::date OR $5 THEN $6 ELSE 0 END WHERE day=ANY($1::date[]) AND scope IN ('global',$2)`,[row.days,row.account_id,row.neurons,row.days[0],unknown,neurons]);
  await client.query(`UPDATE needware_generation_global_reservation SET state='settled',charged=$2,unknown_usage=$3 WHERE job_id=$1`,[row.job_id,neurons,unknown]);
}
export async function reserveGlobalGeneration(client:PoolClient,job:{id:string;owner_id:string;provider:ProviderInfo},policy:GlobalPolicy){
  assertGlobalProvider(job.provider);await lock(client);
  // A timed-out request burns its full bound; expiry only releases concurrency.
  const expired=await client.query<Reservation>(`SELECT * FROM needware_generation_global_reservation WHERE state='reserved' AND expires_at<=now() FOR UPDATE`);
  for(const row of expired.rows)await charge(client,row,row.neurons,true);
  await client.query(`DELETE FROM needware_generation_global_reservation WHERE job_id IN (SELECT job_id FROM needware_generation_global_reservation WHERE state='settled' AND expires_at<now()-interval '2 days' ORDER BY expires_at LIMIT 128)`);
  await client.query(`DELETE FROM needware_generation_global_day WHERE (day,scope) IN (SELECT day,scope FROM needware_generation_global_day WHERE day<(now() AT TIME ZONE 'UTC')::date-2 ORDER BY day,scope LIMIT 128)`);
  if((await client.query('SELECT job_id FROM needware_generation_global_reservation WHERE job_id=$1',[job.id])).rowCount)throw Error('GLOBAL_GENERATION_REPLAY');
  const active=(await client.query(`SELECT count(*)::integer AS total,count(*) FILTER(WHERE account_id=$1)::integer AS account FROM needware_generation_global_reservation WHERE state='reserved'`,[job.owner_id])).rows[0];
  if(active.total>=policy.concurrency||active.account>=1)throw Error('GLOBAL_GENERATION_CONCURRENCY');
  const days=(await client.query(`SELECT ARRAY[(now() AT TIME ZONE 'UTC')::date,(now() AT TIME ZONE 'UTC')::date+1] AS days`)).rows[0].days;
  for(const [scope,ceiling] of [['global',policy.daily],[job.owner_id,policy.accountDaily]] as const){
    await client.query(`INSERT INTO needware_generation_global_day(day,scope,ceiling) SELECT d,$2,$3 FROM unnest($1::date[]) d ON CONFLICT DO NOTHING`,[days,scope,ceiling]);
    const updated=await client.query(`UPDATE needware_generation_global_day SET ceiling=LEAST(ceiling,$3),reserved=reserved+$4 WHERE day=ANY($1::date[]) AND scope=$2 AND reserved+spent+$4<=LEAST(ceiling,$3) RETURNING day`,[days,scope,ceiling,policy.neurons]);
    if(updated.rowCount!==2)throw Error('GLOBAL_GENERATION_QUOTA');
  }
  await client.query(`INSERT INTO needware_generation_global_reservation(job_id,account_id,provider,days,token_ceiling,neurons) VALUES($1,$2,$3,$4,$5,$6)`,[job.id,job.owner_id,JSON.stringify(job.provider),days,policy.tokens,policy.neurons]);
}
export async function reconcileGlobalGeneration(client:PoolClient,id:string,usage:Usage|null){
  await lock(client);const row=(await client.query<Reservation&{expired:boolean}>('SELECT *,expires_at<=now() AS expired FROM needware_generation_global_reservation WHERE job_id=$1 FOR UPDATE',[id])).rows[0];
  if(!row||row.state!=='reserved')return;
  const crossed=(await client.query(`SELECT (now() AT TIME ZONE 'UTC')::date<>$1::date AS crossed`,[row.days[0]])).rows[0].crossed;
  const actual=row.expired?undefined:knownNeurons(usage,row.token_ceiling);
  await charge(client,row,actual===undefined?row.neurons:Math.min(actual,row.neurons),actual===undefined||crossed);
}
