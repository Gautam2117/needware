import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
export async function startWorkerHealth(pool:Pool,worker:'email'|'generation'|'billing'){
  const instance=randomUUID();let state:'running'|'degraded'|'stopped'='running',busy=false,lastPrune=0;
  const heartbeat=async()=>{if(busy)return;busy=true;try{await pool.query(`INSERT INTO needware_worker_health(worker,instance,state) VALUES($1,$2,$3) ON CONFLICT(worker,instance) DO UPDATE SET state=EXCLUDED.state,updated_at=now()`,[worker,instance,state]);if(Date.now()-lastPrune>3600000){await pool.query("DELETE FROM needware_worker_health WHERE updated_at<now()-interval '1 day'");await pool.query("DELETE FROM needware_operator_audit WHERE created_at<now()-interval '30 days'");await pool.query("DELETE FROM needware_abuse_report WHERE state='reviewed' AND reviewed_at<now()-interval '30 days'");lastPrune=Date.now();}}finally{busy=false;}};
  await heartbeat();const timer=setInterval(()=>{void heartbeat().catch(()=>{state='degraded';});},5000);
  return {healthy:()=>{state='running';},degraded:()=>{state='degraded';},stop:async()=>{clearInterval(timer);state='stopped';while(busy)await new Promise(resolve=>setTimeout(resolve,10));await heartbeat();}};
}
