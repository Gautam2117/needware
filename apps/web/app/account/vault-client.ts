import canonicalize from 'canonicalize';
import type { BrowserVault, BrowserRootRotation } from 'needware-wasm-runtime';
import { openVaultStore, type EncryptedVaultStore } from '../../../../packages/browser-host/src/vault-store';
import type { Context, RecoveryEnvelope, Certificate, VaultOperation } from '../../lib/vault-proof';
import {RootPublication} from '../../../../packages/browser-host/src/root-publication';
import {DocumentRelay} from '../../../../packages/browser-host/src/relay-client';
import {DurableSyncSession,type RootCloudCut} from '../../../../packages/browser-host/src/sync-journal';
import type {RootJournalCut} from '../../../../packages/browser-host/src/root-rotation-store';
type Wasm = typeof import('needware-wasm-runtime');
type Remote = { context: Context; authority: string; recovery: RecoveryEnvelope;
  devices: { device_id: string; label: string; certificate: Certificate; created_at: string; root_approval?:unknown }[];proof_chain?:unknown[] };
export type RecoveryFile = { format: 'needware-recovery-v1'; account: string; context: Context; authority: string; code: string; envelope: RecoveryEnvelope };
export type DeviceRequest = { format: 'needware-device-request-v1'; account: string; context: Context; authority: string; device: Certificate['device'] };
export type EnrollmentFile = Omit<DeviceRequest, 'format' | 'device'> & { format: 'needware-device-enrollment-v1'; enrollment: unknown };
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/vault${path}`, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : canonicalize(body) });
  const text = await response.text(); if (text.length > 128 * 1024) throw new Error('Vault response size limit');
  const value = JSON.parse(text);
  if (!response.ok) throw new Error(value.message || 'Encrypted account service unavailable');
  return value as T;
}
export class AccountVaultClient {
  private generation: number | null = null;
  private hasRoot = false;
  private closed = false;
  private rootPending=false;
  private rootPreparation?:{rotation:BrowserRootRotation;candidate:BrowserVault;file:RecoveryFile};
  private constructor(readonly account: string, private readonly wasm: Wasm, private readonly store: EncryptedVaultStore,
    private vault: BrowserVault, private remote: Remote | null) {}
  static async open(account: string): Promise<AccountVaultClient> {
    if (navigator.locks) return navigator.locks.request(`needware-account-vault-open:${account}`, () => this.openUnlocked(account));
    return this.openUnlocked(account);
  }
  private static async openUnlocked(account: string): Promise<AccountVaultClient> {
    const path = '/wasm/needware_wasm.js'; const wasm: Wasm = await import(/* webpackIgnore: true */ path);
    await wasm.default({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
    const store = await openVaultStore(); let vault: BrowserVault | undefined;
    try {
      const remote = (await api<{ vault: Remote | null }>('')).vault;
      if (remote && remote.context.account !== account) throw new Error('Cloud account identity mismatch');
      const local = await store.load(account);
      if (local) {
        try { vault = wasm.BrowserVault.from_local_backup(local.bytes); } finally { local.bytes.fill(0); }
      } else vault = new wasm.BrowserVault(undefined);
      const client = new AccountVaultClient(account, wasm, store, vault, remote);
      client.generation = local?.generation ?? null;
      const pending=local?await store.rotations.load(account):undefined;client.rootPending=Boolean(pending);pending?.bytes.fill(0);
      if (local && vault.enrolled()) {
        client.hasRoot = true;
        const context: Context = JSON.parse(vault.account_context());
        if(context.account!==account)throw new Error('Pinned local account identity differs; original preserved');
        if(remote&&(canonicalize(remote.context)!==canonicalize(context)||remote.authority!==vault.account_authority())){
          if(!client.rootPending)throw new Error('Pinned local account root differs from cloud; original preserved');
          try{await client.resumeRootPublication();}finally{vault=client.vault;}
        }
      }
      if (!local) await client.persist();
      return client;
    } catch (error) { vault?.free(); store.close(); throw error; }
  }
  close(): void { if (!this.closed) { this.closed = true;this.rootPreparation?.candidate.free();this.rootPreparation?.rotation.free(); this.vault.free(); this.store.close(); } }
  private active(): void { if (this.closed) throw new Error('Account vault is closed'); }
  status(): 'new' | 'locked' | 'pending' | 'ready' | 'rotating' {
    this.active();
    if (!this.remote) return 'new';
    if (!this.hasRoot) return 'locked';
    if(this.rootPending)return 'rotating';
    const device = JSON.parse(this.vault.device_public()).id;
    return this.remote.devices.some(value => value.device_id === device) ? 'ready' : 'pending';
  }
  devices() { return this.remote?.devices ?? []; }
  deviceId(): string { return JSON.parse(this.vault.device_public()).id; }
  async resumeRootPublication():Promise<number>{
    this.active();const result=await new RootPublication(this.store,this.vault).resume(),saved=await this.store.load(this.account);if(!saved)throw new Error('Published local vault unavailable');
    let current:BrowserVault;try{current=this.wasm.BrowserVault.from_local_backup(saved.bytes);}finally{saved.bytes.fill(0);}
    this.vault.free();this.vault=current;this.generation=saved.generation;this.rootPending=false;this.remote=(await api<{vault:Remote}>('')).vault;
    if(this.remote.authority!==current.account_authority()||canonicalize(this.remote.context)!==current.account_context())throw new Error('Published account pin changed; keys preserved');
    return result.pendingOwnerRekeys.length;
  }
  async cancelRootPublication():Promise<void>{this.active();await new RootPublication(this.store,this.vault).cancel();this.rootPending=false;}
  prepareRootRecovery():RecoveryFile{
    this.active();if(this.status()!=='ready')throw new Error('Use a current trusted device before rotating account keys');
    if(this.rootPreparation)return this.rootPreparation.file;
    const rotation=this.vault.prepare_root_rotation(true),candidate=rotation.preview(),recovery=JSON.parse(candidate.create_recovery(true));
    const file:RecoveryFile={format:'needware-recovery-v1',account:this.account,context:JSON.parse(candidate.account_context()),authority:candidate.account_authority(),code:recovery.code,envelope:recovery.envelope};
    this.rootPreparation={rotation,candidate,file};return file;
  }
  async rotateRoot(selected:readonly string[],savedRecovery:boolean):Promise<number>{
    this.active();const prepared=this.rootPreparation;if(!prepared||!savedRecovery||this.status()!=='ready')throw new Error('Save and review the new recovery file first');
    const remote=(await api<{vault:Remote}>('')).vault;
    if(remote.authority!==this.vault.account_authority()||canonicalize(remote.context)!==this.vault.account_context()||!selected.includes(this.deviceId())||new Set(selected).size!==selected.length)throw new Error('Trusted device selection or account pin changed');
    const devices=selected.map(id=>{const device=remote.devices.find(device=>device.device_id===id);if(!device)throw new Error('Selected device is no longer trusted');if(id===this.deviceId())return {certificate:JSON.parse(prepared.candidate.device_certificate()),approval:null};const approval=JSON.parse(prepared.candidate.approve_device(canonicalize(device.certificate.device)!,true));return {certificate:approval.certificate,approval};});
    const recipients=devices.filter(device=>device.approval!==null).map(device=>({certificate:canonicalize(device.certificate)!,context:canonicalize(device.certificate.context)!,authority:prepared.candidate.account_authority(),write:true}));
    const relay=new DocumentRelay(this.vault),owned=(await relay.list()).filter(item=>(item.binding as {document:{account:string}}).document.account===this.account),ids=await this.store.documents.list(this.account);
    if(owned.some(doc=>!ids.includes(doc.id)))throw new Error('Open and review every owned cloud application on this browser before rotating account keys');
    const local:RootJournalCut[]=[],cloud:RootCloudCut[]=[],id=crypto.randomUUID();
    try{for(const document of ids){const journal=await DurableSyncSession.open(this.store.documents,this.vault,this.account,document,true);try{
      if(JSON.parse(journal.binding()).document.account!==this.account){local.push(await journal.prepareForeignRootCut(prepared.candidate,prepared.rotation,true));continue;}
      if(!journal.cloudEnabled()){local.push(await journal.prepareLocalRootCut(prepared.candidate,prepared.rotation,true));continue;}
      const source=owned.find(doc=>doc.id===document);if(!source||canonicalize(source.binding)!==canonicalize(JSON.parse(journal.binding())))throw new Error('Cloud application changed or was removed; preserve and review its local work before rotating');
      let synchronized;for(let batch=0;batch<128;batch++){synchronized=await relay.synchronize(journal);if(!synchronized.pending&&!synchronized.more)break;}if(!synchronized||synchronized.pending||synchronized.more)throw new Error('Finish synchronization before rotating account keys');
      const history=await relay.request<{epochs:{generation:string;binding:unknown}[]}>({action:'epoch_history',document}),historical=[];
      for(const epoch of history.epochs){const archived=await relay.request<{owner_key:unknown}>({action:'epoch_archive',document,generation:Number(epoch.generation),cursor:'0'});if(!archived.owner_key)throw new Error('Historical recovery key unavailable; original preserved');historical.push({generation:Number(epoch.generation),held:canonicalize(archived.owner_key)!,binding:canonicalize(epoch.binding)!});}
      cloud.push(await journal.prepareCloudRootCut(prepared.candidate,prepared.rotation,id,recipients,true,historical));
    }finally{await journal.close();}}
      const plan={action:'prepare' as const,id,proof:JSON.parse(prepared.rotation.proof()),recovery:prepared.file.envelope,devices,sources:cloud.map(cut=>cut.source)};
      await new RootPublication(this.store,this.vault).stage(prepared.candidate,plan,local,cloud,true);this.rootPending=true;
    }finally{for(const cut of local)cut.bytes.fill(0);for(const cut of cloud)cut.cut.bytes.fill(0);}
    const pending=await this.resumeRootPublication();prepared.candidate.free();prepared.rotation.free();this.rootPreparation=undefined;return pending;
  }
  private async persist(): Promise<void> {
    this.active(); const bytes = this.vault.local_backup();
    try { this.generation = await this.store.save(this.account, bytes, this.generation); } finally { bytes.fill(0); }
  }
  async prepareRecovery(): Promise<RecoveryFile> {
    this.active(); if (this.remote) throw new Error('Use the existing account recovery or device enrollment');
    if (!this.hasRoot) { this.vault.free(); this.vault = new this.wasm.BrowserVault(this.account); this.hasRoot = true; }
    const { code, envelope } = JSON.parse(this.vault.create_recovery(true));
    await this.persist();
    return { format: 'needware-recovery-v1', account: this.account, context: JSON.parse(this.vault.account_context()),
      authority: this.vault.account_authority(), code, envelope };
  }
  private async register(operation: VaultOperation, payload: unknown): Promise<void> {
    this.active();
    // Resolve a previously committed request whose HTTP response was lost.
    const before = (await api<{ vault: Remote | null }>('')).vault;
    if (before) {
      if (before.authority !== this.vault.account_authority() || canonicalize(before.context) !== this.vault.account_context()) throw new Error('Pinned account root changed; local keys preserved');
      this.remote = before;
      if (before.devices.some(device => device.device_id === this.deviceId())) return;
      if (operation === 'create_vault') throw new Error('Account root already exists; recover or enroll this browser');
    }
    const challenge = await api<{ nonce: string }>('/challenge', { operation });
    this.active();
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(payload)!));
    const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    const proof = JSON.parse(this.vault.account_operation(challenge.nonce, JSON.stringify(operation), digest));
    await api('', { proof, payload });
    const remote = (await api<{ vault: Remote | null }>('')).vault;
    if (!remote || remote.authority !== this.vault.account_authority() || canonicalize(remote.context) !== this.vault.account_context()) {
      throw new Error('Cloud account pin changed; local keys preserved');
    }
    this.remote = remote;
  }
  async create(file: RecoveryFile, label: string): Promise<void> {
    if (!this.hasRoot || file.account !== this.account || file.authority !== this.vault.account_authority()) throw new Error('Recovery file identity mismatch');
    await this.register('create_vault', { recovery: file.envelope, label });
  }
  async registerRecovered(label: string): Promise<void> {
    if (!this.hasRoot || !this.remote) throw new Error('Recover or enroll this device first');
    await this.register('register_device', { label });
  }
  async recover(code: string, label: string): Promise<void> {
    this.active(); if (this.hasRoot || !this.remote) throw new Error('Existing local vault must be preserved');
    this.vault.recover(code.trim(), canonicalize(this.remote.recovery)!, canonicalize(this.remote.context)!, this.remote.authority);
    this.hasRoot = true; await this.persist(); await this.registerRecovered(label);
  }
  async recoverFile(file: RecoveryFile, label: string): Promise<void> {
    this.active(); if (this.hasRoot || !this.remote || file.format !== 'needware-recovery-v1' || file.account !== this.account
        || file.authority !== this.remote.authority || canonicalize(file.context) !== canonicalize(this.remote.context)) throw new Error('Recovery file identity mismatch');
    this.vault.recover(file.code, canonicalize(file.envelope)!, canonicalize(file.context)!, file.authority);
    this.hasRoot = true; await this.persist(); await this.registerRecovered(label);
  }
  deviceRequest(): DeviceRequest {
    if (this.hasRoot || !this.remote) throw new Error('This device does not need enrollment');
    return { format: 'needware-device-request-v1', account: this.account, context: this.remote.context,
      authority: this.remote.authority, device: JSON.parse(this.vault.device_public()) };
  }
  approve(request: DeviceRequest): EnrollmentFile {
    this.active(); if (!this.hasRoot || request.format !== 'needware-device-request-v1' || request.account !== this.account
        || request.authority !== this.vault.account_authority() || canonicalize(request.context) !== this.vault.account_context()) throw new Error('Device request belongs to a different account root');
    const enrollment = JSON.parse(this.vault.approve_device(canonicalize(request.device)!, true));
    return { format: 'needware-device-enrollment-v1', account: this.account, context: request.context, authority: request.authority, enrollment };
  }
  async enroll(file: EnrollmentFile, label: string): Promise<void> {
    this.active(); if (this.hasRoot || !this.remote || file.format !== 'needware-device-enrollment-v1' || file.account !== this.account
        || file.authority !== this.remote.authority || canonicalize(file.context) !== canonicalize(this.remote.context)) throw new Error('Enrollment identity mismatch');
    this.vault.accept_enrollment(canonicalize(file.enrollment)!, canonicalize(file.context)!, file.authority);
    this.hasRoot = true; await this.persist(); await this.registerRecovered(label);
  }
}
