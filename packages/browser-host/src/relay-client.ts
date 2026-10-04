import canonicalize from 'canonicalize';
import type { BrowserVault, BrowserSync } from 'needware-wasm-runtime';
import { DurableSyncSession, type CloudArtifact, type JournalOptions } from './sync-journal';
import type { EncryptedDocumentStore } from './journal-store';
type Descriptor = CloudArtifact['descriptor'];
export type RelayRead = { descriptor: Descriptor; membership: { root_epoch: number; authority: number[] }; key_envelope: { kind: 'held' | 'offer'; value: unknown }; roster: unknown[]; frames: string[]; cursor: string; more: boolean };
export class RelayFailure extends Error { constructor(readonly status: number, readonly retryAfter: number, message: string) { super(message); } }
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
    const nonce=await response<{nonce:string}>(await fetch('/api/vault/challenge',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:canonicalize({operation:'relay_document'}),signal:AbortSignal.timeout(10_000)}),32768);
    const plaintext=new TextEncoder().encode(canonicalize(payload)!);const hash=await digest(plaintext);plaintext.fill(0);
    const proof=JSON.parse(this.vault.account_operation(nonce.nonce,JSON.stringify('relay_document'),hash));
    return response<T>(await fetch('/api/documents',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:canonicalize({proof,payload}),signal:AbortSignal.timeout(15_000)}),3*1024*1024);
  }
  async list(): Promise<{id:string;binding:unknown;ready:boolean}[]> {
    return (await response<{documents:{id:string;binding:unknown;ready:boolean}[]}>(await fetch('/api/documents',{cache:'no-store',signal:AbortSignal.timeout(10_000)}),256*1024)).documents;
  }
  async synchronize(session: DurableSyncSession): Promise<{pending:number;cursor:string;more:boolean}> {
    const artifact=await session.prepareCloud();const document=(artifact.descriptor.binding as {document:{document:string;account:string}}).document;
    const account=JSON.parse(this.vault.account_context()).account;
    // Only the owner publishes package/configuration. Collaborators use their granted existing descriptor.
    if(document.account===account){
      let exists=false;
      try {const remote=await this.request<RelayRead>({action:'read',document:document.document,cursor:session.cursor()||'0'});exists=canonicalize(remote.descriptor)===canonicalize(artifact.descriptor);
        if(!exists)throw new Error('Pinned cloud package differs; local application preserved');}
      catch(error){if(!(error instanceof RelayFailure)||![404,409].includes(error.status))throw error;}
      if(!exists){
        await this.request({action:'create',document:document.document,descriptor:artifact.descriptor,membership:artifact.membership,key_envelope:artifact.key_envelope});
        const content=decode(artifact.ciphertext);
        try {for(let i=(artifact.uploadedChunks||0)*1048576;i<content.length;i+=1048576){await this.request({action:'chunk',document:document.document,index:i/1048576,ciphertext:encode(content.subarray(i,i+1048576))});await session.uploadedChunk(i/1048576+1);}}
        finally {content.fill(0);}
        await this.request({action:'finalize',document:document.document});
      }
    }
    const pulled=await this.request<RelayRead>({action:'read',document:document.document,cursor:session.cursor()||'0'});
    await session.receiveWithRoster(pulled.frames,pulled.cursor,JSON.stringify(pulled.roster));
    let uploaded=0;
    for(const frame of session.pending()){
      if(uploaded>=4)break;const result=await this.request<{digest:string}>({action:'upload',document:document.document,frame});
      if(result.digest!==await digest(new TextEncoder().encode(frame)))throw new Error('Upload acknowledgment mismatch; pending change retained');
      await session.acknowledge([frame]);uploaded++;
    }
    return {pending:session.pending().length,cursor:pulled.cursor,more:pulled.more};
  }
  async recoverOwnerGrant(document: string): Promise<void> {
    const remote=await this.request<{descriptor:Descriptor;key_envelope:{kind:string;value:unknown};root_epoch:number}>({action:'recover',document});
    const binding=remote.descriptor.binding as {document:{document:string;account:string};generation:number};
    if(binding.document.document!==document||binding.document.account!==JSON.parse(this.vault.account_context()).account||remote.root_epoch!==JSON.parse(this.vault.account_context()).epoch||remote.key_envelope.kind!=='held')throw new Error('Owner recovery identity mismatch');
    if(!this.vault.has_document(document))this.vault.restore_held_document_key(canonicalize(remote.key_envelope.value)!,canonicalize(binding.document)!);
    const membership=JSON.parse(this.vault.own_document_membership(document,binding.generation));
    await this.request({action:'grant',document,recipient:JSON.parse(this.vault.device_certificate()),membership,key_envelope:{kind:'held',value:JSON.parse(this.vault.held_document_key_backup(document))}});
  }
  async importDocument(store: EncryptedDocumentStore, account: string, rootGeneration: number, document: string, pin: string, ownerEpoch: number, consent: boolean): Promise<DurableSyncSession> {
    const proposal=await this.prepareImport(store,account,rootGeneration,document,pin,ownerEpoch,consent);
    try{return await proposal.commit();}finally{proposal.close();}
  }
  async prepareImport(store: EncryptedDocumentStore, account: string, rootGeneration: number, document: string, pin: string, ownerEpoch: number, consent: boolean): Promise<PreparedImport> {
    if(!consent)throw new Error('Review the document owner and package before importing');
    const read=await this.request<RelayRead>({action:'read',document,cursor:'0'});
    const binding=read.descriptor.binding as {document:{document:string};generation:number;schema_epoch:number};
    if(binding.document.document!==document||read.membership.root_epoch!==ownerEpoch||read.membership.authority.map(byte=>byte.toString(16).padStart(2,'0')).join('')!==pin)throw new Error('Document owner identity mismatch');
    if(!this.vault.has_document(document)){
      if(read.key_envelope.kind==='held')this.vault.restore_held_document_key(canonicalize(read.key_envelope.value)!,canonicalize(binding.document)!);
      else if(read.key_envelope.kind==='offer')this.vault.accept_document_key(canonicalize(read.key_envelope.value)!,canonicalize(binding.document)!,ownerEpoch,pin,binding.generation,true);
      else throw new Error('Document key envelope unavailable');
    }
    if(!Number.isInteger(read.descriptor.package_bytes)||read.descriptor.package_bytes<40||read.descriptor.package_bytes>33554472)throw new Error('Encrypted package size limit');
    const encrypted=new Uint8Array(read.descriptor.package_bytes);
    for(let i=0;i<encrypted.length;i+=1048576){const chunk=await this.request<{index:number;ciphertext:string}>({action:'download',document,index:i/1048576});const decoded=decode(chunk.ciphertext);
      if(chunk.index!==i/1048576||decoded.length!==Math.min(1048576,encrypted.length-i))throw new Error('Encrypted package chunk mismatch');encrypted.set(decoded,i);decoded.fill(0);}
    if(await digest(encrypted)!==read.descriptor.package_digest)throw new Error('Encrypted package manifest mismatch');
    let bytes: Uint8Array|undefined;let configBytes:Uint8Array|undefined;let session:BrowserSync|undefined;
    try {
      bytes=this.vault.open_document_payload(document,encrypted,`NEEDWARE-CLOUD-PACKAGE-v1:${document}`);
      configBytes=this.vault.open_document_payload(document,decode(read.descriptor.configuration),`NEEDWARE-CLOUD-CONFIGURATION-v1:${document}`);
      const configuration=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(configBytes));
      if(configuration.authority!==pin||configuration.ownerEpoch!==ownerEpoch||canonicalize(JSON.parse(configuration.binding))!==canonicalize(binding))throw new Error('Encrypted configuration pin mismatch');
      session=this.vault.open_shared_document(bytes,document,canonicalize(read.membership)!,ownerEpoch,pin,binding.generation,configuration.scope,binding.schema_epoch,true);
      session.set_roster(canonicalize(read.roster)!);let batch=read;let batches=0;
      for(;;){for(const frame of batch.frames)session.receive(frame);if(!batch.more)break;if(++batches>=128)throw new Error('Import history batch limit');
        batch=await this.request<RelayRead>({action:'read',document,cursor:batch.cursor});session.set_roster(canonicalize(batch.roster)!);}
      const cloud:CloudArtifact={descriptor:read.descriptor,ciphertext:encode(encrypted),membership:read.membership,key_envelope:{kind:'held',value:JSON.parse(this.vault.held_document_key_backup(document))}};
      const proposal=new PreparedImport(store,this.vault,bytes,session,{account,rootGeneration,scope:configuration.scope,ownerEpoch,authority:pin,roster:canonicalize(batch.roster)!,imported:{cursor:batch.cursor,cloud}});session=undefined;bytes=undefined;
      return proposal;
    }finally{encrypted.fill(0);bytes?.fill(0);configBytes?.fill(0);session?.free();}
  }
}
export class PreparedImport {
  constructor(private readonly store:EncryptedDocumentStore,private readonly vault:BrowserVault,private readonly bytes:Uint8Array,private session:BrowserSync|undefined,private readonly options:JournalOptions){}
  inspect<T>(inspect:(bytes:Uint8Array)=>T):T{if(!this.session)throw new Error('Import review closed');return inspect(this.bytes);}
  async commit():Promise<DurableSyncSession>{if(!this.session)throw new Error('Import review closed');
    const durable=await DurableSyncSession.create(this.store,this.vault,this.bytes,this.session,this.options);this.session=undefined;this.bytes.fill(0);return durable;}
  close():void{this.session?.free();this.session=undefined;this.bytes.fill(0);}
}
