// Only the trusted host/worker may hold this session. Renderer frames receive views and effects.
import type { BrowserSync, BrowserVault } from 'needware-wasm-runtime';
import type { EncryptedDocumentStore } from './journal-store';
interface Binding { document: { document: string }; generation: number; schema_epoch: number }
interface Journal {
  version: 1; account: string; document: string; binding: string; scope: string;
  ownerEpoch: number; authority: string; membership: string; held: string; package: string;
  roster: string; frames: string[]; state: string; queued: string[]; cursor: string | null;
  cloud?: CloudArtifact;
  epoch?: { checkpoint: string; previous: string };
  archive?: string[];
  pendingEpoch?: CloudEpochIntent;
}
export interface EpochRecipient { certificate: string; context: string; authority: string; write: boolean }
export interface CloudEpochIntent { next: string; transition: unknown; checkpoint: { digest: string; bytes: number }; sourceCursor: string; recipients?: {recipient:unknown;membership:unknown;key_envelope:unknown}[] }
export interface CloudArtifact { descriptor: { binding: unknown; configuration: string; package_digest: string; package_bytes: number }; ciphertext: string; membership: unknown; key_envelope: unknown; uploadedChunks?: number }
export interface JournalOptions { account: string; rootGeneration: number; scope: string; ownerEpoch: number; authority: string; roster: string; imported?: { cursor: string; cloud: CloudArtifact; epoch?: {checkpoint:string;previous:string} } }
const encoder = new TextEncoder(); const decoder = new TextDecoder('utf-8', { fatal: true });
function encode(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 8192) parts.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  return btoa(parts.join(''));
}
function decode(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
function exportFrames(session: BrowserSync, known: string): string[] { return (JSON.parse(session.export(known)) as unknown[]).map(frame => JSON.stringify(frame)); }
function parse(bytes: Uint8Array, account: string, document: string): Journal {
  const value = JSON.parse(decoder.decode(bytes)) as Journal;
  const fields = ['account','authority','binding','cursor','document','frames','held','membership','ownerEpoch','package','queued','roster','scope','state','version'];
  if (value?.cloud !== undefined) fields.push('cloud'); fields.sort();
  if (value?.epoch !== undefined) fields.push('epoch');
  if (value?.archive !== undefined) fields.push('archive'); fields.sort();
  if (value?.pendingEpoch !== undefined) fields.push('pendingEpoch'); fields.sort();
  if (!value || Object.keys(value).sort().join(',') !== fields.join(',') || value.version !== 1 || value.account !== account || value.document !== document
      || !Number.isSafeInteger(value.ownerEpoch) || value.ownerEpoch < 1
      || !['authority','binding','held','membership','package','roster','scope','state'].every(key => typeof value[key as keyof Journal] === 'string')
      || ![value.frames,value.queued].every(items => Array.isArray(items) && items.length <= 100_000 && items.every(item => typeof item === 'string' && encoder.encode(item).length <= 2 * 1024 * 1024))
      || (value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length > 256))) throw new Error('Invalid document journal; original preserved');
  const binding = JSON.parse(value.binding) as Binding;
  if (binding.document.document !== document) throw new Error('Journal document mismatch');
  if (value.epoch !== undefined && (!value.epoch || Object.keys(value.epoch).sort().join(',') !== 'checkpoint,previous' || typeof value.epoch.checkpoint !== 'string' || typeof value.epoch.previous !== 'string')) throw new Error('Invalid epoch checkpoint');
  if (value.archive !== undefined && (!Array.isArray(value.archive) || value.archive.length > 4 || value.archive.some(item => typeof item !== 'string'))) throw new Error('Invalid retained epoch archive');
  const intentFields=['checkpoint','next','sourceCursor','transition'];
  if(value.pendingEpoch?.recipients!==undefined){
    intentFields.push('recipients');intentFields.sort();const recipients=value.pendingEpoch.recipients;
    if(!Array.isArray(recipients)||recipients.length>255||recipients.some(item=>!item||Object.keys(item).sort().join(',')!=='key_envelope,membership,recipient'||encoder.encode(JSON.stringify(item)).length>32768))throw new Error('Invalid retained epoch recipients');
  }
  if (value.pendingEpoch !== undefined && (!value.pendingEpoch || Object.keys(value.pendingEpoch).sort().join(',') !== intentFields.join(',') || typeof value.pendingEpoch.next !== 'string' || encoder.encode(value.pendingEpoch.next).length > 32*1024*1024 || typeof value.pendingEpoch.sourceCursor !== 'string' || !/^(0|[1-9][0-9]{0,5})$/.test(value.pendingEpoch.sourceCursor) || typeof value.pendingEpoch.checkpoint?.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.pendingEpoch.checkpoint.digest) || !Number.isInteger(value.pendingEpoch.checkpoint.bytes) || value.pendingEpoch.checkpoint.bytes < 40 || value.pendingEpoch.checkpoint.bytes > 16777256)) throw new Error('Invalid durable epoch intent');
  return value;
}
export class DurableSyncSession {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing = false;
  private constructor(private readonly store: EncryptedDocumentStore, private session: BrowserSync, private journal: Journal, private generation: number, private readonly rootGeneration: number) {}
  static async create(store: EncryptedDocumentStore, vault: BrowserVault, packageBytes: Uint8Array, session: BrowserSync, options: JournalOptions): Promise<DurableSyncSession> {
    if (JSON.parse(vault.account_context()).account !== options.account) throw new Error('Vault account mismatch');
    const membership = JSON.parse(session.membership());
    if (membership.authority.map((byte: number) => byte.toString(16).padStart(2,'0')).join('') !== options.authority || membership.root_epoch !== options.ownerEpoch) throw new Error('Document owner pin mismatch');
    session.verify_package(packageBytes);
    session.view();
    session.set_roster(options.roster);
    const binding = session.binding(); const document = (JSON.parse(binding) as Binding).document.document;
    const frames = exportFrames(session, '[]');
    const journal: Journal = { version: 1, account: options.account, document, binding, scope: options.scope, ownerEpoch: options.ownerEpoch,
      authority: options.authority, membership: session.membership(), held: vault.held_document_key_backup(document), package: encode(packageBytes),
      roster: options.roster, frames, state: session.snapshot(), queued: options.imported ? [] : [...frames], cursor: options.imported?.cursor ?? null,
      ...(options.imported ? { cloud: options.imported.cloud, ...(options.imported.epoch ? {epoch:options.imported.epoch} : {}) } : {}) };
    const bytes = encoder.encode(JSON.stringify(journal));
    let generation: number;
    try { generation = await store.save(options.account, document, bytes, null, options.rootGeneration); } finally { bytes.fill(0); }
    return new DurableSyncSession(store, session, journal, generation, options.rootGeneration);
  }
  static async open(store: EncryptedDocumentStore, vault: BrowserVault, account: string, document: string, consent: boolean): Promise<DurableSyncSession> {
    if (!consent) throw new Error('Package and sync scope consent required');
    const saved = await store.load(account, document); if (!saved) throw new Error('Document is unavailable');
    let journal: Journal;
    try { journal = parse(saved.bytes, account, document); } finally { saved.bytes.fill(0); }
    const binding = JSON.parse(journal.binding) as Binding;
    if (JSON.parse(vault.account_context()).account !== account) throw new Error('Vault account mismatch');
    const temporaryBackup = vault.local_backup();
    let stagedVault: BrowserVault;
    try { stagedVault = (vault.constructor as typeof BrowserVault).from_local_backup(temporaryBackup); }
    finally { temporaryBackup.fill(0); }
    let packageBytes: Uint8Array | undefined; let session: BrowserSync;
    try {
      packageBytes = decode(journal.package);
      stagedVault.forget_document(document);
      stagedVault.restore_held_document_key(journal.held, JSON.stringify(binding.document));
      session = stagedVault.open_shared_document(packageBytes, document, journal.membership, journal.ownerEpoch, journal.authority, binding.generation, journal.scope, binding.schema_epoch, true);
    }
    finally { packageBytes?.fill(0); stagedVault.free(); }
    try {
      if (session.binding() !== journal.binding) throw new Error('Package binding mismatch');
      session.set_roster(journal.roster);
      if (journal.epoch) {
        const checkpoint = decode(journal.epoch.checkpoint);
        try { session.install_epoch(checkpoint, journal.epoch.previous); } finally { checkpoint.fill(0); }
      }
      for (const frame of journal.frames) session.receive(frame);
      session.restore_local_state(journal.state);
      session.activate_document_key(vault);
      return new DurableSyncSession(store, session, journal, saved.generation, saved.rootGeneration);
    } catch (error) { session.free(); throw error; }
  }
  view(): string { this.assertOpen(); return this.session.view(); }
  packageBytes(): Uint8Array<ArrayBuffer> { this.assertOpen(); return decode(this.journal.package); }
  static async inspect<T>(store: EncryptedDocumentStore, account: string, document: string, inspect: (bytes: Uint8Array) => T): Promise<T> {
    const saved = await store.load(account, document); if (!saved) throw new Error('Document is unavailable');
    let journal: Journal;
    try { journal = parse(saved.bytes, account, document); } finally { saved.bytes.fill(0); }
    const bytes = decode(journal.package); try { return inspect(bytes); } finally { bytes.fill(0); }
  }
  snapshot(): string { this.assertOpen(); return this.session.snapshot(); }
  pending(): readonly string[] { this.assertOpen(); return [...this.journal.queued]; }
  cursor(): string | null { this.assertOpen(); return this.journal.cursor; }
  binding(): string { this.assertOpen(); return this.journal.binding; }
  cloudEnabled(): boolean { this.assertOpen(); return Boolean(this.journal.cloud); }
  cloudEpochIntent(): CloudEpochIntent | undefined { this.assertOpen();return this.journal.pendingEpoch?structuredClone(this.journal.pendingEpoch):undefined; }
  async stageCloudEpoch(vault: BrowserVault, consent: boolean, retained: readonly EpochRecipient[] = []): Promise<CloudEpochIntent> {
    return this.serial(async () => {
      if(this.journal.pendingEpoch)return structuredClone(this.journal.pendingEpoch);
      if(!this.journal.cloud||this.journal.queued.length||this.journal.cursor===null)throw new Error('Finish encrypted cloud synchronization before approving a new epoch');
      if((this.journal.archive?.length??0)>=4)throw new Error('Retained epoch archive limit; original preserved');
      const prepared=vault.prepare_document_epoch(this.session,consent),candidate=prepared.preview(),checkpoint=prepared.checkpoint();
      const packageBytes=decode(this.journal.package);let content:Uint8Array|undefined,configuration:Uint8Array|undefined;
      try{
        if(retained.length>255)throw new Error('Retained recipient limit');
        const recipients=retained.map(target=>{
          const recipient=JSON.parse(target.certificate),context=JSON.parse(target.context);
          const sameDevice=(a:{id:string;encryption:unknown;signing:unknown},b:typeof a)=>JSON.stringify([a.id,a.encryption,a.signing])===JSON.stringify([b.id,b.encryption,b.signing]);
          const own=context.account===this.journal.account&&target.authority===vault.account_authority()&&context.epoch===JSON.parse(vault.account_context()).epoch;
          const previouslyAuthorized=(JSON.parse(this.journal.roster) as {device:Parameters<typeof sameDevice>[0]}[]).some(grant=>sameDevice(grant.device,recipient.device));
          if(!own&&!previouslyAuthorized)throw new Error('Retained recipient is not a current collaborator; review a separate invitation first');
          const offer=JSON.parse(prepared.offer_document(vault,target.certificate,target.context,target.authority,target.write,consent));
          return {recipient,membership:offer.membership,key_envelope:{kind:'offer',value:offer}};
        });
        const roster=JSON.stringify([JSON.parse(candidate.membership()),...recipients.map(item=>item.membership)]);
        candidate.set_roster(roster);
        const {archive:prior,...previous}=this.journal;
        const next:Journal={...previous,binding:candidate.binding(),membership:candidate.membership(),held:prepared.held_backup(),
          roster,frames:[],queued:[],cursor:'0',state:candidate.snapshot(),
          epoch:{checkpoint:encode(checkpoint),previous:this.journal.binding},archive:[...(prior??[]),JSON.stringify(previous)]};
        content=candidate.seal_payload(packageBytes,`NEEDWARE-CLOUD-PACKAGE-v1:${next.document}`);
        const configBytes=encoder.encode(JSON.stringify({binding:next.binding,scope:next.scope,ownerEpoch:next.ownerEpoch,authority:next.authority}));
        try{configuration=candidate.seal_payload(configBytes,`NEEDWARE-CLOUD-CONFIGURATION-v1:${next.document}`);}finally{configBytes.fill(0);}
        const digest=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        next.cloud={descriptor:{binding:JSON.parse(next.binding),configuration:encode(configuration),package_digest:await digest(content),package_bytes:content.length},ciphertext:encode(content),membership:JSON.parse(next.membership),key_envelope:{kind:'held',value:JSON.parse(next.held)},uploadedChunks:Math.ceil(content.length/1048576)};
        const intent:CloudEpochIntent={next:JSON.stringify(next),transition:JSON.parse(prepared.transition()),checkpoint:{digest:await digest(checkpoint),bytes:checkpoint.length},sourceCursor:this.journal.cursor,...(recipients.length?{recipients}: {})};
        const old=this.session.fork_session();try{await this.publish(old,{...this.journal,pendingEpoch:intent});}catch(error){old.free();throw error;}
        return structuredClone(intent);
      }finally{packageBytes.fill(0);content?.fill(0);configuration?.fill(0);checkpoint.fill(0);candidate.free();prepared.free();}
    });
  }
  async finishCloudEpoch(vault: BrowserVault): Promise<void> {
    return this.serial(async()=>{
      const intent=this.journal.pendingEpoch;if(!intent)throw new Error('Durable epoch intent unavailable');
      const nextBytes=encoder.encode(intent.next);let next:Journal;try{next=parse(nextBytes,this.journal.account,this.journal.document);}finally{nextBytes.fill(0);}
      if(next.pendingEpoch||!next.epoch||!next.cloud)throw new Error('Invalid staged epoch journal');
      const backup=vault.local_backup();let staged:BrowserVault,probe:BrowserVault;
      try{staged=(vault.constructor as typeof BrowserVault).from_local_backup(backup);probe=(vault.constructor as typeof BrowserVault).from_local_backup(backup);}finally{backup.fill(0);}
      const packageBytes=decode(next.package),checkpoint=decode(next.epoch.checkpoint);let candidate:BrowserSync|undefined;
      try{
        staged.forget_document(next.document);staged.restore_held_document_key(next.held,JSON.stringify(JSON.parse(next.binding).document));
        candidate=staged.open_shared_document(packageBytes,next.document,next.membership,next.ownerEpoch,next.authority,JSON.parse(next.binding).generation,next.scope,JSON.parse(next.binding).schema_epoch,true);
        if(candidate.binding()!==next.binding)throw new Error('Epoch package binding mismatch');candidate.set_roster(next.roster);candidate.install_epoch(checkpoint,next.epoch.previous);
        candidate.restore_local_state(next.state);candidate.activate_document_key(probe);candidate.view();
        await this.publish(candidate,next);candidate=undefined;this.session.activate_document_key(vault);
      }finally{packageBytes.fill(0);checkpoint.fill(0);candidate?.free();staged.free();probe.free();}
    });
  }
  async cancelCloudEpoch(): Promise<void> {
    return this.serial(async()=>{if(!this.journal.pendingEpoch)return;const {pendingEpoch:removed,...previous}=this.journal;void removed;
      const candidate=this.session.fork_session();try{await this.publish(candidate,previous);}catch(error){candidate.free();throw error;}});
  }
  private requireActiveEpoch(): void {if(this.journal.pendingEpoch)throw new Error('Key rotation is pending. Resume or cancel it before changing this application.');}
  async compactLocal(vault: BrowserVault, consent: boolean): Promise<void> {
    return this.serial(async () => {
      if (this.journal.cloud) throw new Error('Cloud document requires an atomic cloud epoch transition');
      if ((this.journal.archive?.length ?? 0) >= 4) throw new Error('Retained epoch archive limit; original preserved');
      const prepared = vault.prepare_document_epoch(this.session, consent);
      const candidate = prepared.preview();
      const checkpoint = prepared.checkpoint();
      const { archive: prior, ...previous } = this.journal;
      const journal: Journal = { ...previous, binding: candidate.binding(), membership: candidate.membership(),
        held: prepared.held_backup(), roster: JSON.stringify([JSON.parse(candidate.membership())]),
        frames: [], queued: [], cursor: null, state: candidate.snapshot(),
        epoch: { checkpoint: encode(checkpoint), previous: this.journal.binding },
        archive: [...(prior ?? []), JSON.stringify(previous)] };
      let committed = false;
      try {
        candidate.view();
        await this.publish(candidate, journal);
        committed = true;
        const originalStagedSession = prepared.publish(vault); originalStagedSession.free();
      } catch (error) { if (!committed) candidate.free(); throw error; }
      finally { checkpoint.fill(0); prepared.free(); }
    });
  }
  async uploadedChunk(count: number): Promise<void> {
    return this.serial(async () => {
      const cloud=this.journal.cloud;
      if(!cloud||!Number.isInteger(count)||count<0||count>Math.ceil(cloud.descriptor.package_bytes/1048576))throw new Error('Invalid package upload checkpoint');
      const candidate=this.session.fork_session();
      try{await this.publish(candidate,{...this.journal,cloud:{...cloud,uploadedChunks:count}});}catch(error){candidate.free();throw error;}
    });
  }
  async prepareCloud(): Promise<CloudArtifact> {
    return this.serial(async () => {
      this.requireActiveEpoch();
      if (this.journal.cloud) return structuredClone(this.journal.cloud);
      if (this.journal.epoch) throw new Error('Compacted document requires the cloud epoch publication protocol');
      const candidate = this.session.fork_session(); const packageBytes = decode(this.journal.package);
      const metadata = `NEEDWARE-CLOUD-PACKAGE-v1:${this.journal.document}`;
      let content: Uint8Array; let configuration: Uint8Array | undefined;
      try {
        content = candidate.seal_payload(packageBytes, metadata);
        const configurationBytes = encoder.encode(JSON.stringify({ binding: this.journal.binding, scope: this.journal.scope, ownerEpoch: this.journal.ownerEpoch, authority: this.journal.authority }));
        try { configuration = candidate.seal_payload(configurationBytes, `NEEDWARE-CLOUD-CONFIGURATION-v1:${this.journal.document}`); }
        finally { configurationBytes.fill(0); }
        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(content));
        const cloud: CloudArtifact = { descriptor: { binding: JSON.parse(this.journal.binding), configuration: encode(configuration), package_digest: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join(''), package_bytes: content.length },
          ciphertext: encode(content), membership: JSON.parse(this.journal.membership), key_envelope: { kind: 'held', value: JSON.parse(this.journal.held) } };
        await this.publish(candidate, { ...this.journal, cloud }); return structuredClone(cloud);
      } catch (error) { candidate.free(); throw error; }
      finally { packageBytes.fill(0); configuration?.fill(0); }
    });
  }
  async receiveWithRoster(frames: readonly string[], cursor: string, roster: string): Promise<number> {
    return this.serial(async () => {
      this.requireActiveEpoch();
      if (frames.length > 256 || cursor.length > 256) throw new Error('Relay batch limit');
      const candidate = this.session.fork_session(); let received = 0;
      try {
        candidate.set_roster(roster);
        for (const frame of frames) received += candidate.receive(frame);
        await this.publish(candidate, { ...this.journal, cursor, roster }); return received;
      } catch (error) { candidate.free(); throw error; }
    });
  }
  private assertOpen(): void { if (this.closed) throw new Error('Document session closed'); }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Document session closing'));
    const next = this.tail.then(() => { this.assertOpen(); return run(); });
    this.tail = next.catch(() => undefined); return next;
  }
  async dispatch(event: string): Promise<string> {
    return this.serial(async () => {
      this.requireActiveEpoch();
      const candidate = this.session.fork_session();
      try {
        const known = this.session.known(); const effects = candidate.dispatch(event);
        if ((JSON.parse(effects) as unknown[]).length) throw new Error('Remote capability execution is not available in this host yet; original preserved');
        const queued = [...this.journal.queued, ...exportFrames(candidate, known)];
        await this.publish(candidate, { ...this.journal, queued });
        return effects;
      } catch (error) { candidate.free(); throw error; }
    });
  }
  async receive(frames: readonly string[], cursor: string | null): Promise<number> {
    return this.serial(async () => {
      this.requireActiveEpoch();
      if (frames.length > 256 || (cursor !== null && (typeof cursor !== 'string' || cursor.length > 256))) throw new Error('Relay batch limit');
      const candidate = this.session.fork_session(); let received = 0;
      try {
        for (const frame of frames) received += candidate.receive(frame);
        await this.publish(candidate, { ...this.journal, cursor }); return received;
      } catch (error) { candidate.free(); throw error; }
    });
  }
  async acknowledge(frames: readonly string[]): Promise<void> {
    return this.serial(async () => {
      this.requireActiveEpoch();
      if (frames.length > 256 || frames.some(frame => !this.journal.queued.includes(frame))) throw new Error('Unknown upload acknowledgment');
      const acknowledged = new Set(frames); const candidate = this.session.fork_session();
      try { await this.publish(candidate, { ...this.journal, queued: this.journal.queued.filter(frame => !acknowledged.has(frame)) }); }
      catch (error) { candidate.free(); throw error; }
    });
  }
  private async publish(candidate: BrowserSync, journal: Journal): Promise<void> {
    candidate.view(); // Rendering failure must precede the durable commit and any published effects.
    journal = { ...journal, state: candidate.snapshot(), frames: exportFrames(candidate, '[]') };
    const bytes = encoder.encode(JSON.stringify(journal)); let generation: number;
    try { generation = await this.store.save(journal.account, journal.document, bytes, this.generation, this.rootGeneration); }
    finally { bytes.fill(0); }
    this.session.free(); this.session = candidate; this.journal = journal; this.generation = generation;
  }
  async close(): Promise<void> { this.closing = true; await this.tail; if (!this.closed) { this.closed = true; this.session.free(); } }
}
