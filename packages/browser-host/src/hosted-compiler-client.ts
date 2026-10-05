import canonicalize from 'canonicalize';
import type {ProviderInfo} from '@needware/ir-types/ProviderInfo';
import type {StageEvent} from '@needware/ir-types/StageEvent';
import type {Usage} from '@needware/ir-types/Usage';
import type {EncryptedCommand} from './encrypted-protocol';
import {WorkerHost} from './worker-host';
export type HostedJob={id:string;state:'queued'|'running'|'cancel_requested'|'succeeded'|'failed'|'cancelled';provider:ProviderInfo;stage:StageEvent|null;usage:Usage|null;failure:string|null;recipient:string;created_at:string;finished_at:string|null;result_expires_at:string|null};
async function result(response:Response){const value=await response.json();if(!response.ok)throw Error(value.message??'Hosted creation unavailable');return value;}
export async function createHostedApplication(id:string,account:string,prompt:string,provider:ProviderInfo):Promise<HostedJob>{
  const worker=new WorkerHost<EncryptedCommand>('/encrypted-worker.js',()=>30000);let recipient:unknown;
  try{recipient=await worker.request({kind:'generation-recipient',account});}finally{worker.close();}
  return (await result(await fetch('/api/generation/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:canonicalize({id,prompt,provider,recipient,consent:true}),signal:AbortSignal.timeout(30000)}))).job;
}
export async function cancelHostedApplication(id:string):Promise<HostedJob>{return (await result(await fetch(`/api/generation/jobs/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:canonicalize({action:'cancel'})}))).job;}
export async function pollHostedApplication(id:string,signal:AbortSignal,update:(job:HostedJob)=>void):Promise<HostedJob>{
  let stage='';for(;;){signal.throwIfAborted();const response=await fetch(`/api/generation/jobs/${id}`,{cache:'no-store',signal});
    if(response.status===429){await pause(60000,signal);continue;}
    const job=(await result(response)).job as HostedJob;if(!job||job.id!==id)throw Error('Creation identity mismatch');
    const key=JSON.stringify([job.state,job.stage]);if(key!==stage){stage=key;update(job);}
    if(['succeeded','failed','cancelled'].includes(job.state))return job;await pause(3000,signal);
  }
}
function pause(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
  const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},ms);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
});}
