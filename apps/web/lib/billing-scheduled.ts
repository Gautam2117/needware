import {Pool} from 'pg';
import type {CashfreeConfig} from './cashfree-client.ts';
import {processCashfreeCleanup,processCashfreeEvent,reconcileCashfreeAccounts} from './cashfree-store.ts';
import {startWorkerHealth} from './worker-health.ts';

export async function probeCashfreeHost(options:Pool['options']){
  if(!options.ssl||typeof options.ssl!=='object'||options.ssl.rejectUnauthorized!==true)throw Error('Billing host probe requires certificate-verified database TLS');
  const started=Date.now(),pool=new Pool({...options,max:1,connectionTimeoutMillis:2000,query_timeout:1000,statement_timeout:1000});
  try{
    await pool.query('BEGIN READ ONLY');
    const row=await pool.query("SELECT count(*)::integer AS tables FROM information_schema.tables WHERE table_schema='public'");
    await pool.query('COMMIT');
    if(row.rows[0]?.tables!==44)throw Error('Billing host schema unavailable');
    return {billingHostProbe:'PASS',elapsedMs:Date.now()-started,databaseTls:true,readOnly:true,providerCalls:0};
  }finally{await pool.end();}
}

// Separate short database timeouts keep a stalled tick within the 30s scheduler.
export async function scheduledCashfree(poolOptions:Pool['options'],config:CashfreeConfig){
  const databaseDeadline=Date.now()+24000;
  const raw=new Pool({...poolOptions,max:2,connectionTimeoutMillis:2000,query_timeout:1000,statement_timeout:1000,idleTimeoutMillis:1000});
  const bounded=<T extends {query:unknown}>(target:T):T=>new Proxy(target,{get(object,key){
    if(key==='query')return (...args:unknown[])=>{
      if(Date.now()>=databaseDeadline)return Promise.reject(Error('Billing database deadline reached'));
      return (object.query as (...args:unknown[])=>unknown).apply(object,args);
    };
    if(key==='connect')return async()=>{if(Date.now()>=databaseDeadline)throw Error('Billing database deadline reached');return bounded(await raw.connect());};
    const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;
  }});
  const pool=bounded(raw),scoped={...config,deadline:Date.now()+20000};
  let health:Awaited<ReturnType<typeof startWorkerHealth>>|undefined;
  try{
    health=await startWorkerHealth(pool,'billing',300);
    const cleaned=await processCashfreeCleanup(pool,scoped);
    const processed=await processCashfreeEvent(pool,scoped);
    const reconciled=await reconcileCashfreeAccounts(pool,scoped);
    if(cleaned||processed||reconciled)health.healthy();
    return {ok:true,cleaned,processed,reconciled};
  }catch{health?.degraded();return {ok:false};}
  finally{try{await health?.stop();}finally{await raw.end();}}
}
