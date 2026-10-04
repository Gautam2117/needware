// Root/device backups and document journals commit against the same IndexedDB transaction boundary.
import type { StoredVault } from './vault-store';
export const DOCUMENT_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, accountBytes: 128 * 1024 * 1024, count: 256 });
interface StoredDocument {
  account: string; document: string; version: 1; generation: number;
  nonce: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer;
}
interface Quota { account: string; bytes: number; count: number }
const encoder = new TextEncoder();
function id(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error('Invalid document namespace');
}
function aad(account: string, document: string, generation: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify({ domain: 'NEEDWARE-BROWSER-JOURNAL-v1', account, document, generation }));
}
function validate(value: StoredDocument): void {
  id(value.account); id(value.document);
  if (value.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !(value.nonce instanceof Uint8Array) || value.nonce.byteLength !== 12
      || !(value.ciphertext instanceof ArrayBuffer) || value.ciphertext.byteLength < 17
      || value.ciphertext.byteLength > DOCUMENT_LIMITS.bytes + 16) throw new Error('Invalid encrypted document record');
}
function quota(value: Quota | undefined, account: string): Quota {
  if (!value) return { account, bytes: 0, count: 0 };
  if (value.account !== account || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > DOCUMENT_LIMITS.accountBytes
      || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > DOCUMENT_LIMITS.count) throw new Error('Invalid document quota record');
  return value;
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('Document storage failed')); });
}
export class EncryptedDocumentStore {
  constructor(private readonly db: IDBDatabase, private readonly validateRoot: (value: StoredVault) => void) {}
  private async records(account: string, document: string): Promise<[StoredVault | undefined, StoredDocument | undefined]> {
    id(account); id(document);
    const tx = this.db.transaction(['vaults', 'documents'], 'readonly');
    // Queue both reads before awaiting; WebKit closes transactions across asynchronous work.
    return await Promise.all([result(tx.objectStore('vaults').get(account)), result(tx.objectStore('documents').get([account, document]))]);
  }
  async load(account: string, document: string): Promise<{ rootGeneration: number; generation: number; bytes: Uint8Array<ArrayBuffer> } | undefined> {
    const [root, value] = await this.records(account, document);
    if (!root) throw new Error('Account vault is unavailable; document preserved');
    this.validateRoot(root);
    if (!value) return undefined;
    validate(value);
    if (value.account !== account || value.document !== document) throw new Error('Document namespace mismatch');
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: value.nonce, additionalData: aad(account, document, value.generation), tagLength: 128 }, root.key, value.ciphertext);
    return { rootGeneration: root.generation, generation: value.generation, bytes: new Uint8Array(bytes) };
  }
  async list(account: string): Promise<string[]> {
    id(account);
    const keys = await result(this.db.transaction('documents').objectStore('documents').index('account').getAllKeys(account, DOCUMENT_LIMITS.count + 1));
    if (keys.length > DOCUMENT_LIMITS.count) throw new Error('Document count limit');
    return keys.map(key => { if (!Array.isArray(key) || key[0] !== account || typeof key[1] !== 'string') throw new Error('Invalid document key'); id(key[1]); return key[1]; });
  }
  async save(account: string, document: string, bytes: Uint8Array, expected: number | null, rootGeneration: number): Promise<number> {
    if (!bytes.byteLength || bytes.byteLength > DOCUMENT_LIMITS.bytes) throw new Error('Document journal size limit; original preserved');
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) throw new Error('Invalid document generation');
    const [root, before] = await this.records(account, document);
    if (!root || root.generation !== rootGeneration) throw new Error('Account vault changed; original preserved');
    this.validateRoot(root); if (before) validate(before);
    if ((before?.generation ?? null) !== expected) throw new Error('Document changed in another tab; original preserved');
    const generation = (expected ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('Document generation limit');
    const nonce = crypto.getRandomValues(new Uint8Array(12)); const plaintext = new Uint8Array(bytes);
    let ciphertext: ArrayBuffer;
    try { ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(account, document, generation), tagLength: 128 }, root.key, plaintext); }
    finally { plaintext.fill(0); }
    await this.commit(account, document, expected, rootGeneration, { account, document, version: 1, generation, nonce, ciphertext });
    return generation;
  }
  async remove(account: string, document: string, expected: number, rootGeneration: number): Promise<void> {
    id(account); id(document);
    if (!Number.isSafeInteger(expected) || expected < 1) throw new Error('Invalid document generation');
    await this.commit(account, document, expected, rootGeneration, undefined);
  }
  private async commit(account: string, document: string, expected: number | null, rootGeneration: number, next: StoredDocument | undefined): Promise<void> {
    const tx = this.db.transaction(['vaults', 'documents', 'document-quotas'], 'readwrite');
    await new Promise<void>((resolve, reject) => {
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Document transaction failed; original preserved'));
      const root = tx.objectStore('vaults').get(account);
      const documents = tx.objectStore('documents'); const previous = documents.get([account, document]);
      const quotas = tx.objectStore('document-quotas'); const usage = quotas.get(account);
      let pending = 3;
      const finish = () => {
        if (--pending) return;
        try {
          const currentRoot = root.result as StoredVault | undefined;
          if (!currentRoot || currentRoot.generation !== rootGeneration) throw new Error('Account vault changed; original preserved');
          this.validateRoot(currentRoot);
          const current = previous.result as StoredDocument | undefined; if (current) validate(current);
          if ((current?.generation ?? null) !== expected) throw new Error('Document changed in another tab; original preserved');
          const total = quota(usage.result, account);
          const bytes = total.bytes - (current?.ciphertext.byteLength ?? 0) + (next?.ciphertext.byteLength ?? 0);
          const count = total.count - Number(Boolean(current)) + Number(Boolean(next));
          if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > DOCUMENT_LIMITS.accountBytes || count < 0 || count > DOCUMENT_LIMITS.count) throw new Error('Account document quota exceeded; original preserved');
          if (next) documents.put(next); else documents.delete([account, document]);
          quotas.put({ account, bytes, count });
        } catch (error) { failure = error; tx.abort(); }
      };
      root.onsuccess = finish; previous.onsuccess = finish; usage.onsuccess = finish;
    });
  }
}
