import {loadEnvironment} from './load-environment.mjs';
import {pathToFileURL} from 'node:url';
loadEnvironment();
export async function runBillingWorker({once=false,reuseResources=false,scheduleSeconds=0}={}){
if((reuseResources||scheduleSeconds)&&!once)throw Error('Reusable scheduled workers must be bounded');
const {authResources}=await import('../apps/web/lib/auth-options.ts'),{pool}=authResources();
const {billingProvider}=await import('../apps/web/lib/billing-policy.ts');
const cashfree=billingProvider()==='cashfree',module=await import(cashfree?'../apps/web/lib/cashfree-store.ts':'../apps/web/lib/billing-worker.ts');
const config=cashfree?(await import('../apps/web/lib/cashfree-client.ts')).cashfreeConfig():(await import('../apps/web/lib/billing-config.ts')).billingConfig();
const cleanup=cashfree?module.processCashfreeCleanup:module.processBillingCleanup,event=cashfree?module.processCashfreeEvent:module.processBillingEvent,reconcile=cashfree?module.reconcileCashfreeAccounts:module.reconcileBillingAccounts;
const {startWorkerHealth}=await import('../apps/web/lib/worker-health.ts'),health=await startWorkerHealth(pool,'billing',scheduleSeconds);
let stopped=false,lastReconcile=0;const stop=()=>{stopped=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
try{do{try{const cleaned=await cleanup(pool,config),processed=await event(pool,config);let reconciled=0;if(Date.now()-lastReconcile>60000){lastReconcile=Date.now();reconciled=await reconcile(pool,config)??0;}if(!cashfree||cleaned||processed||reconciled)health.healthy();if(!once&&!cleaned&&!processed)await new Promise(resolve=>setTimeout(resolve,500));}catch{health.degraded();console.error('Billing worker could not settle a lease; durable recovery remains available');if(!once)await new Promise(resolve=>setTimeout(resolve,1000));}if(once)break;}while(!stopped);}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);await health.stop();if(!reuseResources)await pool.end();}
}
if(import.meta.main||import.meta.url===pathToFileURL(process.argv[1]??'').href)await runBillingWorker({once:process.argv.includes('--once')});
