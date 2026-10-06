import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {runMailWorker} from './mail-worker.mjs';
import {runGenerationWorker} from './generation-worker.mjs';
import {authResources} from '../apps/web/lib/auth-options.ts';
import {workersReady} from './production-preflight.mjs';
const url=new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&/^\/needware_scheduled_[0-9a-f]{32}$/.test(url.pathname));
assert.ok(['127.0.0.1','localhost','[::1]'].includes(process.env.SMTP_HOST));
const resources=authResources(),{pool,mail}=resources,options={once:true,reuseResources:true,scheduleSeconds:300},timings=[];
const baseline=['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal));
const ready=()=>workersReady(pool,{NEEDWARE_BILLING_MODE:'disabled',NEEDWARE_WORKER_MODE:'scheduled',NEEDWARE_WORKER_INTERVAL_SECONDS:'300'});
const tick=()=>Promise.all([runMailWorker(options),runGenerationWorker(options)]);
try{
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM needware_email_outbox')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM needware_generation_job')).rows[0].n,0);
  for(let i=0;i<12;i++){const cpu=process.cpuUsage(),start=performance.now();await tick();const used=process.cpuUsage(cpu);timings.push({elapsedMs:performance.now()-start,cpuMs:(used.user+used.system)/1000});}
  assert.deepEqual(await ready(),[]);
  assert.deepEqual(['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal)),baseline);
  const rows=(await pool.query("SELECT DISTINCT ON(worker) worker,state,mode,period_seconds FROM needware_worker_health ORDER BY worker,updated_at DESC,instance DESC")).rows;
  assert.equal(rows.length,2);for(const row of rows){assert.equal(row.state,'idle');assert.equal(row.mode,'scheduled');assert.equal(row.period_seconds,300);}
  assert.deepEqual(await workersReady(pool,{NEEDWARE_BILLING_MODE:'disabled'}),['email','generation']);
  assert.deepEqual(await workersReady(pool,{NEEDWARE_BILLING_MODE:'disabled',NEEDWARE_WORKER_MODE:'scheduled',NEEDWARE_WORKER_INTERVAL_SECONDS:'600'}),['email','generation']);
  await pool.query("UPDATE needware_worker_health SET updated_at=now()-interval '361 seconds'");assert.deepEqual(await ready(),['email','generation']);await tick();assert.deepEqual(await ready(),[]);
  const id=crypto.randomUUID();await pool.query("INSERT INTO needware_worker_health(worker,instance,state,mode,period_seconds,updated_at) VALUES('email',$1,'idle','scheduled',300,now()+interval '10 seconds')",[id]);
  assert.deepEqual(await ready(),['email']);await pool.query('DELETE FROM needware_worker_health WHERE instance=$1',[id]);
  const user=crypto.randomUUID(),recipient=`scheduler-${randomBytes(8).toString('hex')}@needware.invalid`;
  await pool.query('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[user,'Disposable scheduler fixture',recipient]);
  await pool.query("INSERT INTO needware_email_outbox(user_id,recipient,kind,link) VALUES($1,$2,'verify','http://127.0.0.1:3108/account?fixture=scheduled')",[user,recipient]);
  const send=mail.sendMail.bind(mail);mail.sendMail=async()=>{throw Object.assign(Error('Local simulated transport failure'),{code:'ECONNECTION'});};
  await runMailWorker(options);assert.deepEqual(await ready(),['email']);
  const failed=(await pool.query('SELECT attempts,last_error,lease_id,lease_until FROM needware_email_outbox WHERE user_id=$1',[user])).rows[0];
  assert.equal(failed.attempts,1);assert.equal(failed.last_error,'DELIVERY_FAILED');assert.equal(failed.lease_id,null);assert.equal(failed.lease_until,null);
  await pool.query("UPDATE needware_email_outbox SET next_attempt_at=now()+interval '1 hour' WHERE user_id=$1",[user]);await runMailWorker(options);assert.deepEqual(await ready(),['email'],'Empty tick must retain transport degradation');
  mail.sendMail=send;await pool.query('UPDATE needware_email_outbox SET next_attempt_at=now() WHERE user_id=$1',[user]);await runMailWorker(options);assert.deepEqual(await ready(),[]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM needware_email_outbox WHERE user_id=$1',[user])).rows[0].n,0);
  const response=await fetch(`http://127.0.0.1:58025/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);assert.equal((await response.json()).messages.length,1);
  await assert.rejects(runMailWorker({reuseResources:true}),/must be bounded/);await assert.rejects(runGenerationWorker({reuseResources:true}),/must be bounded/);
  const warm=timings.slice(1),mean=warm.reduce((sum,value)=>sum+value.cpuMs,0)/warm.length;
  console.log(JSON.stringify({status:'PASS',runtime:typeof Deno==='undefined'?'Node':'Deno',scope:'local reusable workers, durable mail retry, no external inference/mail',warmMeanCpuMs:mean,warmMaxCpuMs:Math.max(...warm.map(value=>value.cpuMs)),firstTickCpuMs:timings[0].cpuMs,startupExcludedFromTickTiming:true,scheduledHealth:'fresh idle only; latest failure, stale/future/cadence mismatch rejected',signalListenersPreserved:true,hostedResourceQualification:'UNVERIFIED'}));
}finally{mail.close();await pool.end();}
