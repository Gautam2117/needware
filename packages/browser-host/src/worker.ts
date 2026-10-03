import initSqlite from '@sqlite.org/sqlite-wasm';
import initWasm, { BrowserRuntime, authored_example, inspect_package } from 'needware-wasm-runtime';
import type { Command, LibraryEntry, Loaded, PackageInfo, WorkerReply } from './protocol';
import { coordinatedSqlite } from './coordinator';
import { requireSupported } from '../../renderer/src/registry';

let runtime: BrowserRuntime | undefined;
let current: LibraryEntry | undefined;
let storage = 'Unavailable';
interface Persistence {
  list(): Promise<LibraryEntry[]>;
  get(id: string): Promise<LibraryEntry | undefined>;
  put(value: LibraryEntry, expected: number): Promise<void>;
  delete(id: string): Promise<void>;
}
function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed')); });
}
async function indexedDb(): Promise<Persistence> {
  const request = indexedDB.open('needware-fallback-1', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('apps', { keyPath: 'id' });
  const db = await idbRequest(request);
  const transaction = (write: boolean) => db.transaction('apps', write ? 'readwrite' : 'readonly');
  return {
    async list() { return await idbRequest(transaction(false).objectStore('apps').getAll()) as LibraryEntry[]; },
    async get(id) { return await idbRequest(transaction(false).objectStore('apps').get(id)) as LibraryEntry | undefined; },
    async put(value, expected) {
      const tx = transaction(true);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Concurrent state change or quota exceeded'));
        const store = tx.objectStore('apps'); const get = store.get(value.id);
        get.onsuccess = () => { const old = get.result as LibraryEntry | undefined; if ((old?.generation ?? 0) !== expected) { tx.abort(); return; } store.put(value); };
        get.onerror = () => tx.abort();
      });
    },
    async delete(id) {
      const tx = transaction(true); tx.objectStore('apps').delete(id);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    },
  };
}
async function sqlite(): Promise<Persistence> {
  const sqlite3 = await initSqlite();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: '/needware-opfs', initialCapacity: 8 });
  const db = new pool.OpfsSAHPoolDb('/library.sqlite');
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,title TEXT NOT NULL,digest TEXT NOT NULL,bytes BLOB NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL,consent INTEGER NOT NULL);');
  const row = (r: Record<string, unknown>): LibraryEntry => ({ id: String(r.id), title: String(r.title), digest: String(r.digest), bytes: r.bytes as Uint8Array, state: String(r.state), generation: Number(r.generation), consent: r.consent === 1 });
  return {
    async list() { return db.selectObjects('SELECT * FROM apps').map(row); },
    async get(id) { const r = db.selectObject('SELECT * FROM apps WHERE id=?', [id]); return r ? row(r) : undefined; },
    async put(value, expected) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const old = db.selectObject('SELECT generation FROM apps WHERE id=?', [value.id]);
        if (Number(old?.generation ?? 0) !== expected) throw new Error('Application changed in another writer. Reopen it.');
        db.exec({ sql: 'INSERT INTO apps VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,digest=excluded.digest,bytes=excluded.bytes,state=excluded.state,generation=excluded.generation,consent=excluded.consent', bind: [value.id, value.title, value.digest, value.bytes, value.state, value.generation, Number(value.consent)] });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async delete(id) { db.exec({ sql: 'DELETE FROM apps WHERE id=?', bind: [id] }); },
  };
}
let persistence: Persistence;
async function initialize() {
  await initWasm({ module_or_path: '/wasm/needware_wasm_bg.wasm' });
  await navigator.locks.request('needware-storage-initialization-1', async () => {
  const choiceRequest = indexedDB.open('needware-storage-choice-1', 1);
  choiceRequest.onupgradeneeded = () => choiceRequest.result.createObjectStore('settings');
  const choiceDb = await idbRequest(choiceRequest);
  const choice = await idbRequest(choiceDb.transaction('settings').objectStore('settings').get('backend')) as string | undefined;
  if (choice !== 'indexeddb' && 'getDirectory' in navigator.storage) {
    try { persistence = await coordinatedSqlite(sqlite); storage = 'SQLite / OPFS'; }
    catch (error) {
      if (choice === 'opfs') throw new Error(`OPFS recovery required; existing data was preserved: ${String(error)}`);
      persistence = await indexedDb(); storage = 'IndexedDB fallback (OPFS unavailable)';
    }
  } else { persistence = await indexedDb(); storage = 'IndexedDB fallback'; }
  const transaction = choiceDb.transaction('settings', 'readwrite');
  transaction.objectStore('settings').put(storage === 'SQLite / OPFS' ? 'opfs' : 'indexeddb', 'backend');
  await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
  choiceDb.close();
  });
}
const ready = initialize();
async function execute(command: Command): Promise<unknown> {
  await ready;
  switch (command.kind) {
    case 'example': return authored_example();
    case 'inspect': return JSON.parse(inspect_package(command.bytes)) as PackageInfo;
    case 'library': return persistence.list();
    case 'load': {
      const info = JSON.parse(inspect_package(command.bytes)) as PackageInfo;
      for (const screen of info.application.screens) requireSupported(screen.root);
      if (info.application.capabilities.some(c => c.kind !== 'storage' || c.synchronized)) throw new Error('This browser host currently supports local-storage applications only.');
      const old = await persistence.get(info.application.id);
      if (old && old.digest !== info.digest) throw new Error('A different revision exists. Migration review is required; your data has been preserved.');
      const next = new BrowserRuntime(command.bytes, old?.state, command.consent);
      try {
        const entry: LibraryEntry = { id: info.application.id, title: info.application.title, digest: info.digest, bytes: command.bytes, state: next.snapshot(), generation: (old?.generation ?? 0) + 1, consent: true };
        const view = JSON.parse(next.view());
        await persistence.put(entry, old?.generation ?? 0);
        runtime?.free(); runtime = next; current = entry;
        return { info, view, storage } satisfies Loaded;
      } catch (error) { next.free(); throw error; }
    }
    case 'dispatch': {
      if (!runtime || !current) throw new Error('Open an application first.');
      const previous = runtime.snapshot();
      try {
        const effects: unknown[] = JSON.parse(runtime.dispatch(JSON.stringify({ action: command.action, values: command.values, now: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })));
        if (effects.length) throw new Error('Remote capability execution is not available in this host yet.');
        const next = { ...current, state: runtime.snapshot(), generation: current.generation + 1 };
        const view = JSON.parse(runtime.view());
        await persistence.put(next, current.generation); current = next; return view;
      } catch (error) { runtime.restore(previous); throw error; }
    }
    case 'export-state': if (!runtime) throw new Error('No application open.'); return runtime.snapshot();
    case 'delete': await persistence.delete(command.id); if (current?.id === command.id) { runtime?.free(); runtime = undefined; current = undefined; } return null;
  }
}
let queue = Promise.resolve();
function attach(port: MessagePort | DedicatedWorkerGlobalScope) {
  port.onmessage = (event: MessageEvent<{ id: number; command: Command }>) => {
    const { id, command } = event.data;
    queue = queue.then(async () => {
      try { port.postMessage({ id, ok: true, data: await execute(command) } satisfies WorkerReply); }
      catch (error) { port.postMessage({ id, ok: false, error: String(error) } satisfies WorkerReply); }
    });
  };
  if ('start' in port) port.start();
}
if ('onconnect' in self) {
  (self as unknown as SharedWorkerGlobalScope).onconnect = event => attach(event.ports[0]);
} else { attach(self as unknown as DedicatedWorkerGlobalScope); }
