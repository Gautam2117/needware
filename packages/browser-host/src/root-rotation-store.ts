// Trusted-host coordinator only; neither these bytes nor the nonextractable key reach app frames.
import type { StoredVault } from './vault-store';
import { DOCUMENT_LIMITS } from './journal-store';
const encoder = new TextEncoder(), INTENT_LIMIT = 64 * 1024 * 1024;
export interface RootJournalSource { document: string; generation: number }
export interface RootJournalCut extends RootJournalSource { bytes: Uint8Array }
export interface StoredRootRotation { id: string; sources: RootJournalSource[]; nonce: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }
type Pending = StoredRootRotation;
type Root = StoredVault & { rotation?: Pending };
interface Document { account: string; document: string; version: 1; generation: number; nonce: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }
interface Quota { account: string; bytes: number; count: number }
function id(value: string): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error('Invalid root rotation namespace'); }
function sameBytes(left:Uint8Array,right:Uint8Array):boolean { if(left.byteLength!==right.byteLength)return false;for(let index=0;index<left.byteLength;index++)if(left[index]!==right[index])return false;return true; }
function request<T>(value: IDBRequest<T>): Promise<T> { return new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error??new Error('Root rotation storage failed'));}); }
function aad(domain: string, account: string, generation: number, extra: object = {}): Uint8Array<ArrayBuffer> { return encoder.encode(JSON.stringify({domain,...(domain==='NEEDWARE-BROWSER-JOURNAL-v1'?{account}:{id:account}),generation,...extra})); }
function sources(values: readonly RootJournalSource[]): RootJournalSource[] {
  if(values.length>DOCUMENT_LIMITS.count)throw new Error('Root rotation document limit');
  const result=values.map(value=>{id(value.document);if(!Number.isSafeInteger(value.generation)||value.generation<1)throw new Error('Invalid source journal generation');return {document:value.document,generation:value.generation};}).sort((a,b)=>a.document.localeCompare(b.document));
  if(new Set(result.map(value=>value.document)).size!==result.length)throw new Error('Duplicate root rotation journal');return result;
}
export function validateRootRotation(value: Pending): void {
  id(value.id);sources(value.sources);
  if(!(value.nonce instanceof Uint8Array)||value.nonce.byteLength!==12||!(value.ciphertext instanceof ArrayBuffer)||value.ciphertext.byteLength<17||value.ciphertext.byteLength>INTENT_LIMIT+16)throw new Error('Invalid encrypted root rotation intent');
}
function documents(values: Document[], account: string): RootJournalSource[] {
  for(const value of values){id(value.document);if(value.account!==account||value.version!==1||!(value.nonce instanceof Uint8Array)||value.nonce.byteLength!==12||!(value.ciphertext instanceof ArrayBuffer)||value.ciphertext.byteLength<17||value.ciphertext.byteLength>DOCUMENT_LIMITS.bytes+16)throw new Error('Invalid source document record');}
  return sources(values);
}
function usage(value: Quota|undefined, account: string, count: number): Quota {
  const result=value??{account,bytes:0,count:0};
  if(result.account!==account||result.count!==count||!Number.isSafeInteger(result.bytes)||result.bytes<0||result.bytes>DOCUMENT_LIMITS.accountBytes)throw new Error('Invalid root rotation quota');return result;
}
async function encrypt(key: CryptoKey, bytes: Uint8Array, metadata: Uint8Array<ArrayBuffer>): Promise<{nonce:Uint8Array<ArrayBuffer>;ciphertext:ArrayBuffer}> {
  const nonce=crypto.getRandomValues(new Uint8Array(12)),plaintext=new Uint8Array(bytes);
  try{return {nonce,ciphertext:await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:metadata,tagLength:128},key,plaintext)};}finally{plaintext.fill(0);}
}
export class EncryptedRootRotationStore {
  constructor(private readonly db: IDBDatabase,private readonly validateRoot:(value:StoredVault)=>void){}
  private async snapshot(account:string):Promise<[Root|undefined,Document[],Quota|undefined]>{
    id(account);const tx=this.db.transaction(['vaults','documents','document-quotas']);
    return await Promise.all([request(tx.objectStore('vaults').get(account)),request(tx.objectStore('documents').index('account').getAll(account,DOCUMENT_LIMITS.count+1)),request(tx.objectStore('document-quotas').get(account))]);
  }
  async load(account:string):Promise<{id:string;generation:number;sources:RootJournalSource[];bytes:Uint8Array<ArrayBuffer>}|undefined>{
    const [root]=await this.snapshot(account);if(!root)throw new Error('Account vault unavailable');this.validateRoot(root);if(!root.rotation)return undefined;validateRootRotation(root.rotation);
    const value=root.rotation,metadata=aad('NEEDWARE-BROWSER-ROOT-INTENT-v1',account,root.generation,{rotation:value.id,sources:value.sources});
    return {id:value.id,generation:root.generation,sources:structuredClone(value.sources),bytes:new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:value.nonce,additionalData:metadata,tagLength:128},root.key,value.ciphertext))};
  }
  async stage(account:string,rotation:string,bytes:Uint8Array,expected:number,source:readonly RootJournalSource[]):Promise<void>{
    id(rotation);if(!bytes.byteLength||bytes.byteLength>INTENT_LIMIT)throw new Error('Root rotation intent size limit');const cut=sources(source);
    const [root,all,total]=await this.snapshot(account);if(!root||root.generation!==expected||root.rotation)throw new Error('Account root changed or rotation pending; original preserved');this.validateRoot(root);
    const actual=documents(all,account);if(JSON.stringify(actual)!==JSON.stringify(cut))throw new Error('Source journals changed; original preserved');
    const before=usage(total,account,all.length);
    if(before.bytes+bytes.byteLength+16>DOCUMENT_LIMITS.accountBytes)throw new Error('Root rotation account quota exceeded; original preserved');
    const sealed=await encrypt(root.key,bytes,aad('NEEDWARE-BROWSER-ROOT-INTENT-v1',account,expected,{rotation,sources:cut}));
    await this.commit(account,root,all,before,{...root,rotation:{id:rotation,sources:cut,...sealed}},undefined,before.bytes+sealed.ciphertext.byteLength);
  }
  async cancel(account:string,rotation:string,expected:number):Promise<void>{
    const [root,all,total]=await this.snapshot(account);if(!root||root.generation!==expected||root.rotation?.id!==rotation)throw new Error('Root rotation changed; original preserved');this.validateRoot(root);validateRootRotation(root.rotation);
    const before=usage(total,account,all.length),{rotation:removed,...original}=root;
    await this.commit(account,root,all,before,original,undefined,before.bytes-removed.ciphertext.byteLength);
  }
  async publish(account:string,rotation:string,backup:Uint8Array,expected:number,cuts:readonly RootJournalCut[]):Promise<number>{
    if(!backup.byteLength||backup.byteLength>2*1024*1024)throw new Error('Rotated vault backup size limit');
    const [root,all,total]=await this.snapshot(account);if(!root||root.generation!==expected||root.rotation?.id!==rotation)throw new Error('Root rotation changed; original preserved');this.validateRoot(root);validateRootRotation(root.rotation);
    const authenticated=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:root.rotation.nonce,additionalData:aad('NEEDWARE-BROWSER-ROOT-INTENT-v1',account,expected,{rotation,sources:root.rotation.sources}),tagLength:128},root.key,root.rotation.ciphertext));authenticated.fill(0);
    const actual=documents(all,account),cut=sources(cuts);if(JSON.stringify(actual)!==JSON.stringify(root.rotation.sources)||JSON.stringify(actual)!==JSON.stringify(cut))throw new Error('Source journals changed; original preserved');
    const generation=expected+1;if(!Number.isSafeInteger(generation))throw new Error('Root generation limit');const before=usage(total,account,all.length);
    const sealed=await encrypt(root.key,backup,aad('NEEDWARE-BROWSER-VAULT-v1',account,generation));
    const next:Document[]=[];for(const value of cuts){
      if(!value.bytes.byteLength||value.bytes.byteLength>DOCUMENT_LIMITS.bytes||!Number.isSafeInteger(value.generation+1))throw new Error('Rotated journal size/generation limit');
      // Journal AAD uses document before generation, matching the existing storage wire format.
      const metadata=encoder.encode(JSON.stringify({domain:'NEEDWARE-BROWSER-JOURNAL-v1',account,document:value.document,generation:value.generation+1}));
      next.push({account,document:value.document,version:1,generation:value.generation+1,...await encrypt(root.key,value.bytes,metadata)});
    }
    const bytes=before.bytes-root.rotation.ciphertext.byteLength-all.reduce((sum,item)=>sum+item.ciphertext.byteLength,0)+next.reduce((sum,item)=>sum+item.ciphertext.byteLength,0);
    await this.commit(account,root,all,before,{id:account,version:1,generation,key:root.key,...sealed},next,bytes);return generation;
  }
  private async commit(account:string,before:Root,old:Document[],quota:Quota,next:Root,cuts:Document[]|undefined,bytes:number):Promise<void>{
    if(!Number.isSafeInteger(bytes)||bytes<0||bytes>DOCUMENT_LIMITS.accountBytes)throw new Error('Root rotation account quota exceeded; original preserved');
    const tx=this.db.transaction(['vaults','documents','document-quotas'],'readwrite');
    await new Promise<void>((resolve,reject)=>{
      let failure:unknown;tx.oncomplete=()=>resolve();tx.onabort=()=>reject(failure??tx.error??new Error('Root rotation transaction failed; original preserved'));
      const vaults=tx.objectStore('vaults'),journals=tx.objectStore('documents'),quotas=tx.objectStore('document-quotas');
      const root=vaults.get(account),all=journals.index('account').getAll(account,DOCUMENT_LIMITS.count+1),total=quotas.get(account);let remaining=3;
      const finish=()=>{if(--remaining)return;try{
        const current=root.result as Root|undefined;if(!current||current.generation!==before.generation||current.rotation?.id!==before.rotation?.id||!sameBytes(current.nonce,before.nonce)||!sameBytes(new Uint8Array(current.ciphertext),new Uint8Array(before.ciphertext)))throw new Error('Account root changed; original preserved');this.validateRoot(current);
        if(current.rotation&&(!sameBytes(current.rotation.nonce,before.rotation!.nonce)||!sameBytes(new Uint8Array(current.rotation.ciphertext),new Uint8Array(before.rotation!.ciphertext))||JSON.stringify(current.rotation.sources)!==JSON.stringify(before.rotation!.sources)))throw new Error('Root rotation intent changed; original preserved');
        const currentDocs=all.result as Document[],currentSources=documents(currentDocs,account);if(JSON.stringify(currentSources)!==JSON.stringify(documents(old,account)))throw new Error('Source journals changed; original preserved');
        for(const value of currentDocs){const source=old.find(item=>item.document===value.document)!;if(!sameBytes(value.nonce,source.nonce)||!sameBytes(new Uint8Array(value.ciphertext),new Uint8Array(source.ciphertext)))throw new Error('Source journal ciphertext changed; original preserved');}
        const currentQuota=usage(total.result,account,currentDocs.length);if(currentQuota.bytes!==quota.bytes)throw new Error('Account quota changed; original preserved');
        vaults.put(next);if(cuts)for(const value of cuts)journals.put(value);quotas.put({account,bytes,count:currentDocs.length});
      }catch(error){failure=error;tx.abort();}};
      root.onsuccess=finish;all.onsuccess=finish;total.onsuccess=finish;
    });
  }
}
