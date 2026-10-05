import canonicalize from 'canonicalize';
import type { BrowserVault, BrowserSync } from 'needware-wasm-runtime';
import { DurableSyncSession, type CloudArtifact, type JournalOptions, type JournalEpoch, type RetainedJournal } from './sync-journal';
import type { EncryptedDocumentStore } from './journal-store';
type Descriptor = CloudArtifact['descriptor'];
export type RelayRead = { descriptor: Descriptor; epoch?: {previous_binding:unknown;transition:unknown;checkpoint_manifest:{digest:string;bytes:number};root_rotation?:unknown}|null; membership: { root_epoch: number; authority: number[] }; key_envelope: { kind: 'held' | 'offer'; value: unknown }; roster: unknown[]; frames: string[]; cursor: string; more: boolean;owner_rekey_required?:boolean };
export class RelayFailure extends Error { constructor(readonly status: number, readonly retryAfter: number, message: string) { super(message); } }
export class RevisionReviewRequired extends RelayFailure {
  constructor(){super(409,0,'The shared application changed. Offline edits are preserved. Review the current revision before reconnecting.');}
}
const encode = (bytes: Uint8Array) => { const parts=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));return btoa(parts.join('')); };
const decode = (value: string) => Uint8Array.from(atob(value),char=>char.charCodeAt(0));
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
async function response<T>(value: Response, limit: number): Promise<T> {
  const reader=value.body?.getReader();if(!reader)throw new Error('Relay response unavailable');let length=0;const chunks=[];
  for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>limit){await reader.cancel();throw new Error('Relay response size limit');}chunks.push(next.value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!value.ok)throw new RelayFailure(value.status,Math.min(3600,Math.max(1,Number(value.headers.get('retry-after'))||5)),body.message||'Encrypted relay unavailable');return body as T;
}
export class DocumentRelay {
  constructor(private readonly vault: BrowserVault) {}
  async request<T>(payload: unknown): Promise<T> {
    for(let attempt=0;;attempt++){try{return await this.requestOnce<T>(payload);}catch(error){
      if(!(error instanceof RelayFailure)||error.status!==429||attempt>=2)throw error;
      await new Promise(resolve=>setTimeout(resolve,Math.min(60,error.retryAfter)*1000));
    }}
  }
  private async requestOnce<T>(payload:unknown):Promise<T>{
    const nonce=await response<{nonce:string}>(await fetch('/api/vault/challenge',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:canonicalize({operation:'relay_document'}),signal:AbortSignal.timeout(10_000)}),32768);
    const plaintext=new TextEncoder().encode(canonicalize(payload)!);const hash=await digest(plaintext);plaintext.fill(0);
    const proof=JSON.parse(this.vault.account_operation(nonce.nonce,JSON.stringify('relay_document'),hash));
    return response<T>(await fetch('/api/documents',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:canonicalize({proof,payload}),signal:AbortSignal.timeout(15_000)}),3*1024*1024);
  }
  async list(): Promise<{id:string;binding:unknown;ready:boolean}[]> {
    return (await response<{documents:{id:string;binding:unknown;ready:boolean}[]}>(await fetch('/api/documents',{cache:'no-store',signal:AbortSignal.timeout(10_000)}),256*1024)).documents;
  }
  async synchronize(session: DurableSyncSession): Promise<{pending:number;cursor:string;more:boolean}> {
    if(session.cloudEpochIntent())await this.resumeEpoch(session);
    const artifact=await session.prepareCloud();const document=(artifact.descriptor.binding as {document:{document:string;account:string}}).document;
    const account=JSON.parse(this.vault.account_context()).account;
    // Only the owner publishes package/configuration. Collaborators use their granted existing descriptor.
    if(document.account===account){
      let exists=false;
      try {const remote=await this.request<RelayRead>({action:'read',document:document.document,cursor:'0'});exists=canonicalize(remote.descriptor)===canonicalize(artifact.descriptor);
        if(canonicalize(remote.descriptor.binding)!==canonicalize(JSON.parse(session.binding())))throw new RevisionReviewRequired();
        if(!exists)throw new Error('Pinned cloud package differs; local application preserved');}
      catch(error){if(error instanceof RevisionReviewRequired||!(error instanceof RelayFailure)||![404,409].includes(error.status))throw error;}
      if(!exists){
        await this.request({action:'create',document:document.document,descriptor:artifact.descriptor,membership:artifact.membership,key_envelope:artifact.key_envelope});
        const content=decode(artifact.ciphertext);
        try {for(let i=(artifact.uploadedChunks||0)*1048576;i<content.length;i+=1048576){await this.request({action:'chunk',document:document.document,index:i/1048576,ciphertext:encode(content.subarray(i,i+1048576))});await session.uploadedChunk(i/1048576+1);}}
        finally {content.fill(0);}
        await this.request({action:'finalize',document:document.document});
      }
    }
    // A migrated epoch resets its cursor. Authenticate its binding before sending an old cursor.
    let pulled=await this.request<RelayRead>({action:'read',document:document.document,cursor:'0'});
    if(canonicalize(pulled.descriptor.binding)!==canonicalize(JSON.parse(session.binding())))throw new RevisionReviewRequired();
    if(session.cursor()&&session.cursor()!=='0')pulled=await this.request<RelayRead>({action:'read',document:document.document,cursor:session.cursor()!});
    if(canonicalize(pulled.descriptor.binding)!==canonicalize(JSON.parse(session.binding())))throw new RevisionReviewRequired();
    await session.receiveWithRoster(pulled.frames,pulled.cursor,JSON.stringify(pulled.roster));
    let uploaded=0;
    for(const frame of session.pending()){
      if(uploaded>=4)break;const result=await this.request<{digest:string}>({action:'upload',document:document.document,frame});
      if(result.digest!==await digest(new TextEncoder().encode(frame)))throw new Error('Upload acknowledgment mismatch; pending change retained');
      await session.acknowledge([frame]);uploaded++;
    }
    return {pending:session.pending().length,cursor:pulled.cursor,more:pulled.more};
  }
  async rotateEpoch(session:DurableSyncSession,consent:boolean,retained:readonly import('./sync-journal').EpochRecipient[]=[]):Promise<void>{
    if(!consent)throw new Error('Approve fresh keys and removal of existing collaborator grants before rotation');
    if(!session.cloudEpochIntent()){
      const result=await this.synchronize(session);
      if(result.more||result.pending)throw new Error('Finish synchronization and review all shared changes before rotation');
      await session.stageCloudEpoch(this.vault,true,retained);
    }
    await this.resumeEpoch(session);
  }
  async resumeEpoch(session:DurableSyncSession):Promise<void>{
    const intent=session.cloudEpochIntent();if(!intent)throw new Error('Durable epoch intent unavailable');
    const next=JSON.parse(intent.next),artifact=next.cloud as CloudArtifact;
    const binding=artifact.descriptor.binding as {document:{document:string};generation:number};const document=binding.document.document,generation=binding.generation;
    let status:{status:string;binding:unknown;chunks:{kind:string;chunk_index:number}[]}|undefined;
    try{status=await this.request({action:'epoch_status',document,generation});}catch(error){if(!(error instanceof RelayFailure)||error.status!==404)throw error;}
    if(status&&canonicalize(status.binding)!==canonicalize(binding))throw new Error('Cloud epoch intent differs; local history preserved');
    if(status?.status==='active'){await session.finishCloudEpoch(this.vault);return;}
    if(status&&status.status!=='staging')throw new Error('Epoch has been superseded; review retained local history');
    await this.request({action:'epoch_prepare',document,descriptor:artifact.descriptor,transition:intent.transition,checkpoint:intent.checkpoint,source_cursor:intent.sourceCursor,membership:artifact.membership,key_envelope:artifact.key_envelope,...(intent.recipients?{recipients:intent.recipients}: {}),...(next.epoch.revision?{schema_revision:true}:{})});
    for(const [kind,encoded] of [['package',artifact.ciphertext],['checkpoint',next.epoch.checkpoint]] as const){
      const content=decode(encoded);try{for(let offset=0;offset<content.length;offset+=1048576){const index=offset/1048576;
        if(status?.chunks.some(chunk=>chunk.kind===kind&&chunk.chunk_index===index))continue;
        const bytes=content.subarray(offset,offset+1048576);const ack=await this.request<{index:number;digest:string}>({action:'epoch_chunk',document,generation,kind,index,ciphertext:encode(bytes)});
        if(ack.index!==index||ack.digest!==await digest(bytes))throw new Error('Staged encrypted chunk acknowledgment mismatch');
      }}finally{content.fill(0);}
    }
    const active=await this.request<{status:string;generation:number}>({action:'epoch_activate',document,generation});
    if(active.status!=='active'||active.generation!==generation)throw new Error('Epoch activation acknowledgment mismatch');await session.finishCloudEpoch(this.vault);
  }
  async cancelEpoch(session:DurableSyncSession):Promise<void>{
    const intent=session.cloudEpochIntent();if(!intent)return;const binding=JSON.parse(intent.next).cloud.descriptor.binding;
    try{await this.request({action:'epoch_cancel',document:binding.document.document,generation:binding.generation});}
    catch(error){if(!(error instanceof RelayFailure)||error.status!==404)throw error;}
    await session.cancelCloudEpoch();
  }
  async recoverOwnerGrant(document: string): Promise<void> {
    // Keep an explicitly retained grant; recovery must not overwrite its HPKE offer.
    try{
      const current=await this.request<{descriptor:Descriptor;membership:{device:{id:string}}}>({action:'read',document,cursor:'0'});
      const bound=current.descriptor.binding as {document:{account:string;document:string}};
      if(bound.document.account!==JSON.parse(this.vault.account_context()).account||bound.document.document!==document||current.membership.device.id!==JSON.parse(this.vault.device_public()).id)throw new Error('Owner grant identity mismatch');
      return;
    }catch(error){if(!(error instanceof RelayFailure)||error.status!==403)throw error;}
    const remote=await this.request<{descriptor:Descriptor;key_envelope:{kind:string;value:unknown};root_epoch:number}>({action:'recover',document});
    const binding=remote.descriptor.binding as {document:{document:string;account:string};generation:number};
    if(binding.document.document!==document||binding.document.account!==JSON.parse(this.vault.account_context()).account||remote.root_epoch!==JSON.parse(this.vault.account_context()).epoch||remote.key_envelope.kind!=='held')throw new Error('Owner recovery identity mismatch');
    const backup=this.vault.local_backup();let staged:BrowserVault;
    try{staged=(this.vault.constructor as typeof BrowserVault).from_local_backup(backup);}finally{backup.fill(0);}
    try{
      staged.forget_document(document);staged.restore_held_document_key(canonicalize(remote.key_envelope.value)!,canonicalize(binding.document)!);
      const membership=JSON.parse(staged.own_document_membership(document,binding.generation));
      await this.request({action:'grant',document,recipient:JSON.parse(staged.device_certificate()),membership,key_envelope:{kind:'held',value:JSON.parse(staged.held_document_key_backup(document))}});
    }finally{staged.free();}
  }
  async importDocument(store: EncryptedDocumentStore, account: string, rootGeneration: number, document: string, pin: string, ownerEpoch: number, consent: boolean): Promise<DurableSyncSession> {
    const proposal=await this.prepareImport(store,account,rootGeneration,document,pin,ownerEpoch,consent);
    try{return await proposal.commit();}finally{proposal.close();}
  }
  async prepareImport(store: EncryptedDocumentStore, account: string, rootGeneration: number, document: string, pin: string, ownerEpoch: number, consent: boolean): Promise<PreparedImport> {
    if(!consent)throw new Error('Review the document owner and package before importing');
    const backup=this.vault.local_backup();let staged:BrowserVault;
    try{staged=(this.vault.constructor as typeof BrowserVault).from_local_backup(backup);}finally{backup.fill(0);}
    try{
    const read=await this.request<RelayRead>({action:'read',document,cursor:'0'});
    const binding=read.descriptor.binding as {document:{document:string};generation:number;schema_epoch:number};
    if(binding.document.document!==document||read.membership.root_epoch!==ownerEpoch||read.membership.authority.map(byte=>byte.toString(16).padStart(2,'0')).join('')!==pin)throw new Error('Document owner identity mismatch');
    staged.forget_document(document);
    {
      if(read.key_envelope.kind==='held')staged.restore_held_document_key(canonicalize(read.key_envelope.value)!,canonicalize(binding.document)!);
      else if(read.key_envelope.kind==='offer')staged.accept_document_key(canonicalize(read.key_envelope.value)!,canonicalize(binding.document)!,ownerEpoch,pin,binding.generation,true);
      else throw new Error('Document key envelope unavailable');
    }
    if(!Number.isInteger(read.descriptor.package_bytes)||read.descriptor.package_bytes<40||read.descriptor.package_bytes>33554472)throw new Error('Encrypted package size limit');
    const encrypted=new Uint8Array(read.descriptor.package_bytes);
    for(let i=0;i<encrypted.length;i+=1048576){const chunk=await this.request<{index:number;ciphertext:string}>({action:'download',document,index:i/1048576});const decoded=decode(chunk.ciphertext);
      if(chunk.index!==i/1048576||decoded.length!==Math.min(1048576,encrypted.length-i))throw new Error('Encrypted package chunk mismatch');encrypted.set(decoded,i);decoded.fill(0);}
    if(await digest(encrypted)!==read.descriptor.package_digest)throw new Error('Encrypted package manifest mismatch');
    let bytes: Uint8Array|undefined;let configBytes:Uint8Array|undefined;let session:BrowserSync|undefined;
    try {
      bytes=staged.open_document_payload(document,encrypted,`NEEDWARE-CLOUD-PACKAGE-v1:${document}`);
      configBytes=staged.open_document_payload(document,decode(read.descriptor.configuration),`NEEDWARE-CLOUD-CONFIGURATION-v1:${document}`);
      const configuration=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(configBytes));
      if(configuration.authority!==pin||configuration.ownerEpoch!==ownerEpoch||canonicalize(JSON.parse(configuration.binding))!==canonicalize(binding))throw new Error('Encrypted configuration pin mismatch');
      session=staged.open_shared_document(bytes,document,canonicalize(read.membership)!,ownerEpoch,pin,binding.generation,configuration.scope,binding.schema_epoch,true);
      session.set_roster(canonicalize(read.roster)!);
      let importedEpoch:JournalEpoch|undefined;
      if(read.epoch){
        if(binding.generation<2)throw new Error('Unexpected initial document epoch checkpoint');
        const expected=read.epoch?.checkpoint_manifest;
        if(!expected||!Number.isInteger(expected.bytes)||expected.bytes<40||expected.bytes>16777256||typeof expected.digest!=='string'||!/^[0-9a-f]{64}$/.test(expected.digest))throw new Error('Encrypted epoch checkpoint manifest unavailable');
        const checkpoint=new Uint8Array(expected.bytes);try{
          for(let offset=0;offset<checkpoint.length;offset+=1048576){const index=offset/1048576,chunk=await this.request<{index:number;ciphertext:string}>({action:'epoch_download',document,index});const decoded=decode(chunk.ciphertext);
            try{if(chunk.index!==index||decoded.length!==Math.min(1048576,checkpoint.length-offset))throw new Error('Encrypted checkpoint chunk mismatch');checkpoint.set(decoded,offset);}finally{decoded.fill(0);}}
          if(await digest(checkpoint)!==expected.digest)throw new Error('Encrypted checkpoint digest mismatch');
          const previous=canonicalize(read.epoch!.previous_binding)!;
          if(read.epoch!.root_rotation){session.install_accepted_root_epoch(checkpoint,previous);importedEpoch={checkpoint:encode(checkpoint),previous,acceptedRoot:true};}
          else if(binding.schema_epoch!==JSON.parse(previous).schema_epoch){session.install_revision_epoch(checkpoint,previous);importedEpoch={checkpoint:encode(checkpoint),previous,revision:true};}
          else{session.install_epoch(checkpoint,previous);importedEpoch={checkpoint:encode(checkpoint),previous};}
        }finally{checkpoint.fill(0);}
      }
      session.set_roster(canonicalize(read.roster)!);
      let batch=read;let batches=0;
      for(;;){for(const frame of batch.frames)session.receive(frame);if(!batch.more)break;if(++batches>=128)throw new Error('Import history batch limit');
        batch=await this.request<RelayRead>({action:'read',document,cursor:batch.cursor});session.set_roster(canonicalize(batch.roster)!);}
      const cloud:CloudArtifact={descriptor:read.descriptor,ciphertext:encode(encrypted),membership:read.membership,key_envelope:{kind:'held',value:JSON.parse(staged.held_document_key_backup(document))}};
      const saved=await store.load(account,document);let retained:RetainedJournal|undefined;
      if(saved){try{
        const source=new TextDecoder('utf-8',{fatal:true}).decode(saved.bytes),prior=JSON.parse(source);
        if(prior.account!==account||prior.document!==document||prior.authority!==pin)throw new Error('Existing owner pin differs; original preserved');
        const wasmPath='/wasm/needware_wasm.js';const {inspect_package}=await import(/* webpackIgnore: true */wasmPath) as typeof import('needware-wasm-runtime');
        const previousPackage=decode(prior.package);let previousInfo;
        try{previousInfo=JSON.parse(inspect_package(previousPackage));}finally{previousPackage.fill(0);}
        const nextInfo=JSON.parse(inspect_package(bytes));
        if(previousInfo.application.id!==nextInfo.application.id||!importedEpoch)throw new Error('Shared revision chain needs further review; original preserved');
        const oldBinding=JSON.parse(prior.binding);
        if(importedEpoch.revision){
          if(canonicalize(JSON.parse(importedEpoch.previous))!==canonicalize(oldBinding)||nextInfo.application.parent!==previousInfo.digest)throw new Error('Updated package does not name the exact signed parent and source epoch; original preserved');
        }else if(previousInfo.digest!==nextInfo.digest||oldBinding.document.account!==(binding.document as {account?:string}).account||oldBinding.document.document!==binding.document.document||oldBinding.schema_epoch!==binding.schema_epoch||oldBinding.generation>=binding.generation)throw new Error('Shared recovery requires an unchanged signed package and schema; original preserved');
        retained={source,generation:saved.generation,rootGeneration:saved.rootGeneration};
      }finally{saved.bytes.fill(0);}}
      const proposal=new PreparedImport(store,this.vault,bytes,session,{account,rootGeneration,scope:configuration.scope,ownerEpoch,authority:pin,roster:canonicalize(batch.roster)!,imported:{cursor:batch.cursor,cloud,epoch:importedEpoch}},staged,retained);session=undefined;bytes=undefined;
      return proposal;
    }finally{encrypted.fill(0);bytes?.fill(0);configBytes?.fill(0);session?.free();}
    }catch(error){staged.free();throw error;}
  }
}
export class PreparedImport {
  constructor(private readonly store:EncryptedDocumentStore,private readonly vault:BrowserVault,private readonly bytes:Uint8Array,private session:BrowserSync|undefined,private readonly options:JournalOptions,private readonly staged:BrowserVault,private readonly retained?:RetainedJournal){}
  inspect<T>(inspect:(bytes:Uint8Array)=>T):T{if(!this.session)throw new Error('Import review closed');return inspect(this.bytes);}
  offlineReview():{pending:number;state:string}|undefined{if(!this.session)throw new Error('Import review closed');if(!this.retained)return;const source=JSON.parse(this.retained.source);return {pending:source.queued.length,state:source.state};}
  async commit(preserveOffline=false):Promise<DurableSyncSession>{if(!this.session)throw new Error('Import review closed');
    if(this.retained&&!preserveOffline)throw new Error('Review and explicitly retain the old revision and offline edits before adopting the shared revision');
    const backup=this.vault.local_backup();let probe:BrowserVault;try{probe=(this.vault.constructor as typeof BrowserVault).from_local_backup(backup);}finally{backup.fill(0);}
    try{this.session.activate_document_key(probe);}finally{probe.free();}
    const durable=await DurableSyncSession.create(this.store,this.staged,this.bytes,this.session,this.options,this.retained);this.session.activate_document_key(this.vault);this.session=undefined;this.bytes.fill(0);return durable;}
  close():void{this.session?.free();this.session=undefined;this.bytes.fill(0);this.staged.free();}
}
