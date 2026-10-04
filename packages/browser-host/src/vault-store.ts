// Trusted-host storage only. App frames must never receive this object or its bytes.
const MAX_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
interface StoredVault {
  id: string;
  version: 1;
  generation: number;
  key: CryptoKey;
  nonce: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error ?? new Error('Vault storage failed')); });
}
function metadata(id: string, generation: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify({ domain: 'NEEDWARE-BROWSER-VAULT-v1', id, generation }));
}
function identifier(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid vault namespace');
}
function validate(value: StoredVault): void {
  identifier(value.id);
  if (value.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !(value.key instanceof CryptoKey) || value.key.extractable || value.key.algorithm.name !== 'AES-GCM'
      || !value.key.usages.includes('encrypt') || !value.key.usages.includes('decrypt')
      || value.nonce.byteLength !== 12 || value.ciphertext.byteLength < 16 || value.ciphertext.byteLength > MAX_BYTES + 16) throw new Error('Invalid encrypted vault record');
}
export async function openVaultStore(): Promise<EncryptedVaultStore> {
  if (!globalThis.isSecureContext || !crypto.subtle) throw new Error('Secure browser storage is required');
  const opening = indexedDB.open('needware-vault-1', 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore('vaults', { keyPath: 'id' });
  const db = await request(opening); db.onversionchange = () => db.close();
  return new EncryptedVaultStore(db);
}
export class EncryptedVaultStore {
  constructor(private readonly db: IDBDatabase) {}
  close(): void { this.db.close(); }
  private async record(id: string): Promise<StoredVault | undefined> {
    identifier(id);
    return await request(this.db.transaction('vaults', 'readonly').objectStore('vaults').get(id)) as StoredVault | undefined;
  }
  async load(id: string): Promise<{ generation: number; bytes: Uint8Array<ArrayBuffer> } | undefined> {
    const value = await this.record(id); if (!value) return undefined;
    validate(value);
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: value.nonce, additionalData: metadata(id, value.generation), tagLength: 128 }, value.key, value.ciphertext);
    return { generation: value.generation, bytes: new Uint8Array(bytes) };
  }
  async save(id: string, bytes: Uint8Array, expected: number | null): Promise<number> {
    identifier(id);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new Error('Vault backup size limit');
    const before = await this.record(id);
    if ((before?.generation ?? null) !== expected) throw new Error('Vault changed in another tab; original preserved');
    if (before) validate(before);
    const generation = (expected ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('Vault generation limit');
    const key = before?.key ?? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12)); const plaintext = new Uint8Array(bytes);
    let ciphertext: ArrayBuffer;
    try { ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: metadata(id, generation), tagLength: 128 }, key, plaintext); }
    finally { plaintext.fill(0); }
    const value: StoredVault = { id, version: 1, generation, key, nonce, ciphertext };
    const tx = this.db.transaction('vaults', 'readwrite');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Vault changed; original preserved'));
      const store = tx.objectStore('vaults'); const read = store.get(id);
      read.onsuccess = () => {
        const current = read.result as StoredVault | undefined;
        if ((current?.generation ?? null) !== expected) { tx.abort(); return; }
        store.put(value);
      };
    });
    return generation;
  }
}
