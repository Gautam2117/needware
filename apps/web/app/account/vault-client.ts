import canonicalize from 'canonicalize';
import type { BrowserVault } from 'needware-wasm-runtime';
import { openVaultStore, type EncryptedVaultStore } from '../../../../packages/browser-host/src/vault-store';
import type { Context, RecoveryEnvelope, Certificate, VaultOperation } from '../../lib/vault-proof';
type Wasm = typeof import('needware-wasm-runtime');
type Remote = { context: Context; authority: string; recovery: RecoveryEnvelope;
  devices: { device_id: string; label: string; certificate: Certificate; created_at: string }[] };
export type RecoveryFile = { format: 'needware-recovery-v1'; account: string; context: Context; authority: string; code: string; envelope: RecoveryEnvelope };
export type DeviceRequest = { format: 'needware-device-request-v1'; account: string; context: Context; authority: string; device: Certificate['device'] };
export type EnrollmentFile = Omit<DeviceRequest, 'format' | 'device'> & { format: 'needware-device-enrollment-v1'; enrollment: unknown };
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/vault${path}`, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : canonicalize(body) });
  const text = await response.text(); if (text.length > 32 * 1024) throw new Error('Vault response size limit');
  const value = JSON.parse(text);
  if (!response.ok) throw new Error(value.message || 'Encrypted account service unavailable');
  return value as T;
}
export class AccountVaultClient {
  private generation: number | null = null;
  private hasRoot = false;
  private closed = false;
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
      if (local && vault.enrolled()) {
        client.hasRoot = true;
        const context: Context = JSON.parse(vault.account_context());
        if (context.account !== account || (remote && (canonicalize(remote.context) !== canonicalize(context)
            || remote.authority !== vault.account_authority()))) throw new Error('Pinned local account root differs from cloud; original preserved');
      }
      if (!local) await client.persist();
      return client;
    } catch (error) { vault?.free(); store.close(); throw error; }
  }
  close(): void { if (!this.closed) { this.closed = true; this.vault.free(); this.store.close(); } }
  private active(): void { if (this.closed) throw new Error('Account vault is closed'); }
  status(): 'new' | 'locked' | 'pending' | 'ready' {
    this.active();
    if (!this.remote) return 'new';
    if (!this.hasRoot) return 'locked';
    const device = JSON.parse(this.vault.device_public()).id;
    return this.remote.devices.some(value => value.device_id === device) ? 'ready' : 'pending';
  }
  devices() { return this.remote?.devices ?? []; }
  deviceId(): string { return JSON.parse(this.vault.device_public()).id; }
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
