import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {loadEnvironment} from './load-environment.mjs';
loadEnvironment();
export async function runGenerationWorker({once=false,reuseResources=false,scheduleSeconds=0}={}){
if((reuseResources||scheduleSeconds)&&!once)throw Error('Reusable scheduled workers must be bounded');
if(process.env.NEEDWARE_HOSTED_GENERATION!=='1')throw Error('Enable hosted generation only after configuring accounts and the private gateway');
const {authResources}=await import('../apps/web/lib/auth-options.ts'),{pool,origin}=authResources();
const {claimGenerationJob,dispatchGenerationJob,finishGenerationJob,generationRecipient,pruneGenerationJobs}=await import('../apps/web/lib/generation-store.ts');
const {generationProvider}=await import('../apps/web/lib/generation-provider.ts'),{privateControlConfig}=await import('../apps/web/lib/control-config.ts');
const {startWorkerHealth}=await import('../apps/web/lib/worker-health.ts');
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{default:canonicalize}=await import(require.resolve('canonicalize'));
const wasmDirectory=process.env.NEEDWARE_WASM_DIR??join(process.cwd(),'apps/web/public/wasm'),wasm=await import(pathToFileURL(join(wasmDirectory,'needware_wasm.js')).href);
await wasm.default({module_or_path:await readFile(join(wasmDirectory,'needware_wasm_bg.wasm'))});
const health=await startWorkerHealth(pool,'generation',scheduleSeconds);
let stopped=false,current;
const stop=()=>{stopped=true;current?.abort();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
const number=value=>Number.isSafeInteger(value)&&value>=0;
function usage(value,ceiling){
  const keys=['configured_cost_microusd','conservative_cost_microusd','input_tokens','output_tokens','unknown_usage_requests'];
  if(!value||Object.keys(value).sort().join(',')!==keys.sort().join(',')||!keys.every(key=>number(value[key]))||Math.max(value.configured_cost_microusd,value.conservative_cost_microusd)>ceiling||value.input_tokens+value.output_tokens>1000000)throw Error('INVALID_USAGE');return value;
}
async function compile(job,signal){
  const config=privateControlConfig();if(!config)throw Error('PROVIDER_UNAVAILABLE');
  const response=await fetch(new URL('/api/compile-jobs',config.endpoint),{method:'POST',headers:{...config.headers,'Content-Type':'application/json'},body:JSON.stringify({prompt:job.prompt}),signal,redirect:'error'});
  if(!response.ok||!response.body||!response.headers.get('content-type')?.startsWith('text/event-stream'))throw Error('PROVIDER_UNAVAILABLE');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',total=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.length;if(total>8*1024*1024)throw Error('RESULT_SIZE_LIMIT');buffer+=decoder.decode(chunk.value,{stream:true});
    for(;;){const end=buffer.indexOf('\n\n');if(end<0)break;const event=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)continue;
      const message=JSON.parse(data);
      if(message.kind==='stage'){
        const stage=message.event;if(!stage||Object.keys(stage).sort().join(',')!=='attempt,elapsed_ms,stage,usage'||!['extract_intent','generate_definition','repair_definition','validate_definition','package_verified','cancelled','failed'].includes(stage.stage)||!number(stage.attempt)||stage.attempt>2||!number(stage.elapsed_ms)||stage.elapsed_ms>185000)throw Error('INVALID_STAGE');usage(stage.usage,Number(job.reservation));
        const updated=await pool.query(`UPDATE needware_generation_job SET stage=$3 WHERE id=$1 AND lease_id=$2 AND state='running' RETURNING id`,[job.id,job.lease_id,canonicalize(stage)]);if(!updated.rowCount)throw Error('CANCELLED');
      }else if(message.kind==='error')throw Error('COMPILATION_FAILED');
      else if(message.kind==='package'){
        if(typeof message.package_base64!=='string'||message.package_base64.length>5592408)throw Error('RESULT_SIZE_LIMIT');
        const bytes=Buffer.from(message.package_base64,'base64');if(bytes.toString('base64')!==message.package_base64||bytes.length>4194304)throw Error('INVALID_PACKAGE');
        try{const info=JSON.parse(wasm.inspect_package(bytes));if(info.signers.length!==1||info.signers[0]!==job.provider.signing_authority)throw Error('SIGNER_CHANGED');
          const sealed=wasm.seal_generation_package(bytes,canonicalize(job.recipient.device),canonicalize({version:1,account:job.owner_id,job:job.id}));
          try{return {result:{metadata:JSON.parse(sealed.metadata()),ciphertext:Buffer.from(sealed.ciphertext()),digest:info.digest},usage:usage(message.usage,Number(job.reservation))};}finally{sealed.free();}
        }finally{bytes.fill(0);}
      }else throw Error('INVALID_COMPILER_MESSAGE');
    }
  }throw Error('INTERRUPTED_USAGE_UNKNOWN');}finally{await reader.cancel();}
}
async function work(){const job=await claimGenerationJob(pool);if(!job)return false;
  const controller=new AbortController();current=controller;let heartbeatBusy=false;
  const heartbeat=setInterval(async()=>{if(heartbeatBusy)return;heartbeatBusy=true;try{
    const client=await pool.connect();try{await client.query('BEGIN');await generationRecipient(client,job.owner_id,job.recipient);
      const active=await client.query(`UPDATE needware_generation_job SET lease_until=now()+interval '90 seconds' WHERE id=$1 AND lease_id=$2 AND state='running' RETURNING id`,[job.id,job.lease_id]);await client.query('COMMIT');if(!active.rowCount)controller.abort();
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }catch{controller.abort();}finally{heartbeatBusy=false;}},10000);
  let result=null,reported=null,failure='COMPILATION_FAILED';
  try{const provider=await generationProvider(new URL(origin).protocol==='https:');if(canonicalize(provider)!==canonicalize(job.provider))throw Error('PROVIDER_CHANGED');
    await dispatchGenerationJob(pool,job);const compiled=await compile(job,AbortSignal.any([controller.signal,AbortSignal.timeout(185000)]));result=compiled.result;reported=compiled.usage;
  }catch(error){failure=['PROVIDER_CHANGED','PROVIDER_UNAVAILABLE','SIGNER_CHANGED','INVALID_USAGE','RESULT_SIZE_LIMIT','INTERRUPTED_USAGE_UNKNOWN','COMPILATION_FAILED'].includes(error.message)?error.message:controller.signal.aborted?'CANCELLED':'INTERRUPTED_USAGE_UNKNOWN';}
  finally{clearInterval(heartbeat);current=undefined;}
  try{await finishGenerationJob(pool,job,result,reported,failure);}finally{result?.ciphertext.fill(0);job.prompt=null;}
  return true;
}
let lastPrune=0;
try{do{try{if(Date.now()-lastPrune>60000){await pruneGenerationJobs(pool);lastPrune=Date.now();}if(!await work()&&!once)await new Promise(resolve=>setTimeout(resolve,500));health.healthy();}catch{health.degraded();console.error('Generation worker could not settle a lease; durable retry/recovery remains available');if(!once)await new Promise(resolve=>setTimeout(resolve,1000));}
  if(once)break;
}while(!stopped);}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);await health.stop();if(!reuseResources)await pool.end();}
}
if(import.meta.main||import.meta.url===pathToFileURL(process.argv[1]??'').href)await runGenerationWorker({once:process.argv.includes('--once')});
