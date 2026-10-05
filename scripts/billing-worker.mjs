import {loadEnvironment} from './load-environment.mjs';
loadEnvironment();
const {authResources}=await import('../apps/web/lib/auth-options.ts'),{pool}=authResources();
const {billingConfig}=await import('../apps/web/lib/billing-config.ts'),config=billingConfig();
const {processBillingEvent,processBillingCleanup,reconcileBillingAccounts}=await import('../apps/web/lib/billing-worker.ts');
const {startWorkerHealth}=await import('../apps/web/lib/worker-health.ts'),health=await startWorkerHealth(pool,'billing');
let stopped=false,lastReconcile=0;process.on('SIGINT',()=>{stopped=true;});process.on('SIGTERM',()=>{stopped=true;});
try{do{try{const cleanup=await processBillingCleanup(pool,config),event=await processBillingEvent(pool,config);if(Date.now()-lastReconcile>60000){await reconcileBillingAccounts(pool,config);lastReconcile=Date.now();}health.healthy();if(!cleanup&&!event)await new Promise(resolve=>setTimeout(resolve,500));}catch{health.degraded();console.error('Billing worker could not settle a lease; durable recovery remains available');await new Promise(resolve=>setTimeout(resolve,1000));}if(process.argv.includes('--once'))break;}while(!stopped);}finally{await health.stop();await pool.end();}
