import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
export async function startWorkerHealth(pool:Pool,worker:'email'|'generation'|'billing',periodSeconds=0){
  if(!Number.isInteger(periodSeconds)||(periodSeconds!==0&&(periodSeconds<60||periodSeconds>3600)))throw Error('Invalid worker schedule');
  const mode=periodSeconds?'scheduled':'continuous';
  const instance=randomUUID();let state:'running'|'degraded'|'stopped'|'idle'='running',busy=false,lastPrune=0;
  if(periodSeconds){const previous=await pool.query("SELECT state FROM needware_worker_health WHERE worker=$1 AND mode='scheduled' ORDER BY updated_at DESC,instance DESC LIMIT 1",[worker]);if(previous.rows[0]?.state==='degraded')state='degraded';}
  const heartbeat=async()=>{if(busy)return;busy=true;try{await pool.query(`INSERT INTO needware_worker_health(worker,instance,state,mode,period_seconds) VALUES($1,$2,$3,$4,$5) ON CONFLICT(worker,instance) DO UPDATE SET state=EXCLUDED.state,updated_at=now()`,[worker,instance,state,mode,periodSeconds||null]);if(Date.now()-lastPrune>3600000){await pool.query("DELETE FROM needware_worker_health WHERE updated_at<now()-interval '1 day'");await pool.query("DELETE FROM needware_operator_audit WHERE created_at<now()-interval '30 days'");await pool.query("DELETE FROM needware_abuse_report WHERE state='reviewed' AND reviewed_at<now()-interval '30 days'");lastPrune=Date.now();}}finally{busy=false;}};
  await heartbeat();const timer=setInterval(()=>{void heartbeat().catch(()=>{state='degraded';});},5000);
  return {healthy:()=>{state='running';},degraded:()=>{state='degraded';},stop:async()=>{clearInterval(timer);if(!periodSeconds)state='stopped';else if(state==='running')state='idle';while(busy)await new Promise(resolve=>setTimeout(resolve,10));await heartbeat();}};
}
