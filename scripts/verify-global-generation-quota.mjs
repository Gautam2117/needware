// Real concurrent PostgreSQL transactions, isolated local DB, zero provider calls.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {loadEnvironment} from './load-environment.mjs';
import {globalGenerationPolicy,knownNeurons,reserveGlobalGeneration,reconcileGlobalGeneration} from '../apps/web/lib/generation-global-quota.ts';
loadEnvironment();
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{Pool}=require('pg');
const source=new URL(process.env.DATABASE_URL);assert.ok(['127.0.0.1','localhost','[::1]'].includes(source.hostname));
const database=`needware_global_${randomBytes(16).toString('hex')}`,admin=new Pool({connectionString:source.toString()});let pool,created=false;
const env={NEEDWARE_GENERATION_QUOTA:'cloudflare-free',NEEDWARE_BILLING_MODE:'disabled'};
for(const mode of ['stripe','cashfree'])assert.deepEqual(globalGenerationPolicy({...env,NEEDWARE_BILLING_MODE:mode}),globalGenerationPolicy(env),'Billing must not expand the global free budget');
assert.throws(()=>globalGenerationPolicy({NEEDWARE_BILLING_MODE:'disabled'}));
for(const change of [{NEEDWARE_GENERATION_DAILY_NEURONS:'10001'},{NEEDWARE_GENERATION_MAX_TOKENS:'50001'},{NEEDWARE_GENERATION_CONCURRENCY:'3'},{NEEDWARE_GENERATION_QUOTA:'paid'},{NEEDWARE_GENERATION_ACCOUNT_NEURONS:'0'}])assert.throws(()=>globalGenerationPolicy({...env,...change}));
assert.equal(knownNeurons({input_tokens:1000,output_tokens:1000,unknown_usage_requests:0},50000),100);
assert.equal(knownNeurons({input_tokens:1,output_tokens:0,unknown_usage_requests:1},50000),undefined);
assert.equal(knownNeurons({input_tokens:50001,output_tokens:0,unknown_usage_requests:0},50000),undefined);
try{
  await admin.query(`CREATE DATABASE "${database}"`);created=true;source.pathname=`/${database}`;pool=new Pool({connectionString:source.toString(),max:16});
  await pool.query(await readFile('services/control-plane/migrations/0012-global-generation-quota.sql','utf8'));
  Object.assign(process.env,env,{NEEDWARE_FIXTURE_MODE:'1',BETTER_AUTH_URL:'http://127.0.0.1:3108',NEEDWARE_LOCAL_ENDPOINT:'http://127.0.0.1:9999/infer'});
  const policy=globalGenerationPolicy(),provider={fixture:true,kind:'local',model:'contract-fixture',endpoint:process.env.NEEDWARE_LOCAL_ENDPOINT};
  const job=(owner=randomUUID())=>({id:randomUUID(),owner_id:owner,provider});
  const transaction=async fn=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  const reserve=(j,p=policy)=>transaction(c=>reserveGlobalGeneration(c,j,p));
  const settle=(j,usage)=>transaction(c=>reconcileGlobalGeneration(c,j.id,usage));
  const totals=async()=>(await pool.query("SELECT * FROM needware_generation_global_day WHERE scope='global' ORDER BY day")).rows;
  const candidates=Array.from({length:12},()=>job()),results=await Promise.allSettled(candidates.map(j=>reserve(j)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2,'Global concurrency must serialize separate users');
  for(const row of await totals()){assert.equal(row.reserved,6820);assert.equal(row.spent,0);}
  const accepted=candidates.filter((_,i)=>results[i].status==='fulfilled'),first=accepted[0],second=accepted[1];
  await assert.rejects(reserve(first),/REPLAY/);
  await assert.rejects(reserve(job(first.owner_id)),/CONCURRENCY/);
  await assert.rejects(reserve({...job(),provider:{...provider,fixture:false,model:'paid-fallback'}}),/PROVIDER/);
  const measured={input_tokens:1000,output_tokens:1000,unknown_usage_requests:0};
  await settle(first,measured);await settle(first,measured);
  let rows=await totals();assert.equal(rows[0].reserved,3410);assert.equal(rows[0].spent,100);assert.equal(rows[1].spent,0);
  // Reconnect uses exactly the same durable accounting, independent of process memory.
  await pool.end();pool=new Pool({connectionString:source.toString(),max:16});
  const third=job();await reserve(third);await settle(second,null);await settle(third,null);
  rows=await totals();assert.equal(rows[0].spent,6920);assert.equal(rows[1].spent,6820);assert.equal(rows[0].reserved,0);
  const count=async()=>(await pool.query('SELECT count(*)::integer AS n FROM needware_generation_global_reservation')).rows[0].n;
  const prior=await count();await assert.rejects(reserve(job()),/QUOTA/);assert.equal(await count(),prior);
  for(const row of await totals())assert.equal(row.reserved,0,'Failed reservation rolls every ledger mutation back');
  // Guarded local-only fault phases never change production clocks or quotas.
  await pool.query('TRUNCATE needware_generation_global_reservation,needware_generation_global_day');
  const stale=job();await reserve(stale);await pool.query("UPDATE needware_generation_global_reservation SET expires_at=now()-interval '1 second' WHERE job_id=$1",[stale.id]);
  const next=job();await reserve(next);assert.equal((await pool.query('SELECT charged,unknown_usage FROM needware_generation_global_reservation WHERE job_id=$1',[stale.id])).rows[0].charged,3410);
  await settle(stale,measured);assert.equal((await totals())[0].spent,3410,'Late reports cannot refund interrupted usage');
  await settle(next,measured);
  const sameAccount=job(stale.owner_id);await assert.rejects(reserve(sameAccount),/QUOTA/);
  await pool.query('TRUNCATE needware_generation_global_reservation,needware_generation_global_day');
  const atomic=job();await assert.rejects(transaction(async c=>{await reserveGlobalGeneration(c,atomic,policy);throw Error('INJECTED_DISPATCH_FAILURE');}),/INJECTED/);assert.equal(await count(),0);assert.equal((await totals()).length,0);
  const changed=job();await reserve(changed,{...policy,daily:4000});await settle(changed,null);await assert.rejects(reserve(job(),policy),/QUOTA/,'Restart with a larger cap cannot raise an existing day ceiling');
  await pool.query('TRUNCATE needware_generation_global_reservation,needware_generation_global_day');
  const midnight=job();await reserve(midnight);
  await pool.query("UPDATE needware_generation_global_day SET day=day-1");await pool.query("UPDATE needware_generation_global_reservation SET days=ARRAY[(now() AT TIME ZONE 'UTC')::date-1,(now() AT TIME ZONE 'UTC')::date] WHERE job_id=$1",[midnight.id]);
  await settle(midnight,measured);for(const row of await totals())assert.equal(row.spent,100,'A request spanning UTC midnight charges both days');
  await pool.query("UPDATE needware_generation_global_reservation SET expires_at=now()-interval '3 days' WHERE job_id=$1",[midnight.id]);
  await reserve(job());assert.equal((await pool.query('SELECT job_id FROM needware_generation_global_reservation WHERE job_id=$1',[midnight.id])).rowCount,0,'Expired account metadata is pruned after the protected quota periods');
  await pool.query('TRUNCATE needware_generation_global_reservation,needware_generation_global_day');const late=job();await reserve(late);await pool.query("UPDATE needware_generation_global_reservation SET expires_at=now()-interval '1 second' WHERE job_id=$1",[late.id]);await settle(late,measured);for(const row of await totals())assert.equal(row.spent,3410,'Expiry alone prevents a late usage refund without another dispatch');
  console.log('PASS global quota: concurrent accounts, replay, no paid fallback, reconciliation, unknown usage, restart, expiry, account cap, atomic rollback, immutable daily cap; zero provider calls');
}finally{await pool?.end();try{if(created)await admin.query(`DROP DATABASE "${database}"`);}finally{await admin.end();}}
