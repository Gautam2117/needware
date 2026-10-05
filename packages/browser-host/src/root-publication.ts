import canonicalize from 'canonicalize';
import type {BrowserVault} from 'needware-wasm-runtime';
import type {EncryptedVaultStore} from './vault-store';
import type {RootJournalCut} from './root-rotation-store';
import type {RootCloudCut} from './sync-journal';
import {DocumentRelay,RelayFailure} from './relay-client';
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const encode=(bytes:Uint8Array)=>{const parts=[];for(let index=0;index<bytes.length;index+=8192)parts.push(String.fromCharCode(...bytes.subarray(index,index+8192)));return btoa(parts.join(''));};
const decode=(value:string)=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
const digest=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const same=(left:unknown,right:unknown)=>canonicalize(left)===canonicalize(right);
type PublicPlan={action:'prepare';id:string;proof:unknown;recovery:unknown;devices:unknown[];sources:RootCloudCut['source'][]};
type Intent={version:1;backup:string;plan:PublicPlan;cuts:{document:string;generation:number;bytes:string;prepare?:Record<string,unknown>}[]};
type Status={id:string;status:'staging'|'active';proof:unknown;sources:{document:string;binding:unknown;cursor:string}[];pending_owner_rekeys:{document_id:string;generation:number}[]};
async function response<T>(result:Response):Promise<T>{
  const reader=result.body?.getReader();if(!reader)throw new Error('Account root response unavailable');const chunks=[];let size=0;
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>3*1024*1024){await reader.cancel();throw new Error('Account root response size limit');}chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const body=JSON.parse(decoder.decode(bytes));if(!result.ok)throw new RelayFailure(result.status,Math.min(3600,Math.max(1,Number(result.headers.get('retry-after'))||5)),body.message||'Account root service unavailable');return body as T;
}
/** Trusted host only. The durable intent contains secrets and never enters an application frame. */
export class RootPublication {
  constructor(private readonly store:EncryptedVaultStore,private readonly source:BrowserVault){}
  private account():string{return JSON.parse(this.source.account_context()).account;}
  private async locked<T>(operation:()=>Promise<T>):Promise<T>{
    return navigator.locks?navigator.locks.request(`needware-account-root-publication:${this.account()}`,operation):operation();
  }
  private async request<T>(vault:BrowserVault,payload:unknown):Promise<T>{
    for(let attempt=0;;attempt++){try{return await this.requestOnce<T>(vault,payload);}catch(error){
      if(!(error instanceof RelayFailure)||error.status!==429||attempt>=2)throw error;
      await new Promise(resolve=>setTimeout(resolve,Math.min(60,error.retryAfter)*1000));
    }}
  }
  private async requestOnce<T>(vault:BrowserVault,payload:unknown):Promise<T>{
    const nonce=await response<{nonce:string}>(await fetch('/api/vault/challenge',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:canonicalize({operation:'rotate_root'}),signal:AbortSignal.timeout(10_000)}));
    const bytes=encoder.encode(canonicalize(payload)!);let hash:string;try{hash=await digest(bytes);}finally{bytes.fill(0);}
    const proof=JSON.parse(vault.account_operation(nonce.nonce,JSON.stringify('rotate_root'),hash));
    return response<T>(await fetch('/api/vault/rotation',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:canonicalize({proof,payload}),signal:AbortSignal.timeout(60_000)}));
  }
  async stage(candidate:BrowserVault,plan:PublicPlan,local:readonly RootJournalCut[],cloud:readonly RootCloudCut[],savedRecovery:boolean):Promise<void>{
    await this.locked(async()=>{
      if(!savedRecovery)throw new Error('Save the new recovery file before publishing the account root');
      const account=this.account(),next=JSON.parse(candidate.account_context()),previous=JSON.parse(this.source.account_context());
      if(plan.action!=='prepare'||next.account!==account||next.epoch!==previous.epoch+1||plan.sources.length!==cloud.length||!same(plan.sources.map(source=>source.document).sort(),cloud.map(cut=>cut.cut.document).sort()))throw new Error('Account root candidate or document cut mismatch');
      const current=await this.store.load(account);if(!current)throw new Error('Account vault unavailable');current.bytes.fill(0);
      const backup=candidate.local_backup();let bytes:Uint8Array|undefined;
      try{
        const cuts=[...local.map(cut=>({document:cut.document,generation:cut.generation,bytes:encode(cut.bytes)})),...cloud.map(cut=>({document:cut.cut.document,generation:cut.cut.generation,bytes:encode(cut.cut.bytes),prepare:cut.prepare}))];
        bytes=encoder.encode(JSON.stringify({version:1,backup:encode(backup),plan,cuts} satisfies Intent));
        await this.store.rotations.stage(account,plan.id,bytes,current.generation,cuts.map(cut=>({document:cut.document,generation:cut.generation})));
      }finally{backup.fill(0);bytes?.fill(0);}
    });
  }
  private async pending(){
    const saved=await this.store.rotations.load(this.account());if(!saved)throw new Error('Encrypted account root intent unavailable');
    let intent:Intent;try{intent=JSON.parse(decoder.decode(saved.bytes));}finally{saved.bytes.fill(0);}
    if(intent.version!==1||intent.plan.id!==saved.id||!same(saved.sources,intent.cuts.map(cut=>({document:cut.document,generation:cut.generation})).sort((a,b)=>a.document.localeCompare(b.document))))throw new Error('Encrypted account root intent differs');
    const backup=decode(intent.backup);let candidate:BrowserVault;try{candidate=(this.source.constructor as typeof BrowserVault).from_local_backup(backup);}finally{backup.fill(0);}
    return {saved,intent,candidate};
  }
  private async status(candidate:BrowserVault,id:string):Promise<Status|undefined>{
    try{return await this.request(this.source,{action:'status',id});}catch(error){
      if(!(error instanceof RelayFailure))throw error;if(error.status===404)return undefined;if(error.status!==403)throw error;
      return this.request(candidate,{action:'status',id});
    }
  }
  async resume():Promise<{generation:number;pendingOwnerRekeys:Status['pending_owner_rekeys']}>{
    return this.locked(async()=>{
      const {saved,intent,candidate}=await this.pending(),relay=new DocumentRelay(this.source);
      try{
        let status=await this.status(candidate,saved.id);
        if(status?.status!=='active'){
          await this.request(this.source,intent.plan);
          for(const cut of intent.cuts){if(!cut.prepare)continue;const journal=JSON.parse(decoder.decode(decode(cut.bytes))),generation=journal.cloud.descriptor.binding.generation;
            await relay.request(cut.prepare);
            const staged=await relay.request<{chunks:{kind:string;chunk_index:number}[]}>({action:'epoch_status',document:cut.document,generation,root_rotation:saved.id});
            for(const [kind,encoded] of [['package',journal.cloud.ciphertext],['checkpoint',journal.epoch.checkpoint]]){
              const bytes=decode(encoded);try{for(let offset=0;offset<bytes.length;offset+=1048576){const index=offset/1048576;if(staged.chunks.some(chunk=>chunk.kind===kind&&chunk.chunk_index===index))continue;
                const chunk=bytes.subarray(offset,offset+1048576),ack=await relay.request<{index:number;digest:string}>({action:'epoch_chunk',document:cut.document,generation,root_rotation:saved.id,kind,index,ciphertext:encode(chunk)});
                if(ack.index!==index||ack.digest!==await digest(chunk))throw new Error('Root document chunk acknowledgment differs');
              }}finally{bytes.fill(0);}
            }
          }
          await this.request(this.source,{action:'activate',id:saved.id});
          status=await this.request(candidate,{action:'status',id:saved.id});
        }
        const expected=intent.plan.sources.map(({document,binding,cursor})=>({document,binding,cursor})).sort((a,b)=>a.document.localeCompare(b.document));
        if(!status||status.id!==saved.id||status.status!=='active'||!same(status.proof,intent.plan.proof)||!same(status.sources,expected))throw new Error('Published account root differs; encrypted intent and originals preserved');
        const backup=candidate.local_backup(),cuts=intent.cuts.map(cut=>({document:cut.document,generation:cut.generation,bytes:decode(cut.bytes)}));
        try{return {generation:await this.store.rotations.publish(this.account(),saved.id,backup,saved.generation,cuts),pendingOwnerRekeys:status.pending_owner_rekeys};}
        finally{backup.fill(0);for(const cut of cuts)cut.bytes.fill(0);}
      }finally{candidate.free();}
    });
  }
  async cancel():Promise<void>{
    await this.locked(async()=>{const {saved,candidate}=await this.pending();try{
      const status=await this.status(candidate,saved.id);if(status?.status==='active')throw new Error('Published account roots cannot be cancelled; resume encrypted local publication');
      if(status)await this.request(this.source,{action:'cancel',id:saved.id});
      await this.store.rotations.cancel(this.account(),saved.id,saved.generation);
    }finally{candidate.free();}});
  }
}
