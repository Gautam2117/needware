import initSqlite from '@sqlite.org/sqlite-wasm';
import initWasm, { BrowserRuntime, authored_example, inspect_package } from 'needware-wasm-runtime';
import type { Command, LibraryEntry, Loaded, PackageInfo, WorkerReply } from './protocol';
import { coordinatedSqlite, type Persistence } from './coordinator';
import { requireSupported } from '../../renderer/src/registry';

let runtime: BrowserRuntime | undefined;
let current: LibraryEntry | undefined;
let instance = '';
let storage = 'Unavailable';
let pending: { source: BrowserRuntime; before: LibraryEntry; bytes: Uint8Array; info: PackageInfo } | undefined;
const same = (a: LibraryEntry | undefined, b: LibraryEntry) => a?.generation === b.generation && a.digest === b.digest && a.state === b.state;
const historySize = (entry: LibraryEntry) => entry.bytes.byteLength + new TextEncoder().encode(entry.state).byteLength;
const historyRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed')); });
}
async function indexedDb(): Promise<Persistence> {
  const request = indexedDB.open('needware-fallback-1', 2);
  request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('apps')) db.createObjectStore('apps', { keyPath: 'id' }); if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: ['id', 'generation'] }); };
  const db = await idbRequest(request);
  db.onversionchange = () => db.close();
  const transaction = (write: boolean) => db.transaction('apps', write ? 'readwrite' : 'readonly');
  return {
    async list() { return await idbRequest(transaction(false).objectStore('apps').getAll()) as LibraryEntry[]; },
    async get(id) { return await idbRequest(transaction(false).objectStore('apps').get(id)) as LibraryEntry | undefined; },
    async history(id) { return await idbRequest(db.transaction('history').objectStore('history').getAll(historyRange(id))) as LibraryEntry[]; },
    async revise(value, before) {
      const tx = db.transaction(['apps', 'history'], 'readwrite');
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Revision changed or history limit exceeded; data preserved.'));
        const apps = tx.objectStore('apps'); const history = tx.objectStore('history'); const get = apps.get(value.id);
        get.onsuccess = () => {
          if (!same(get.result as LibraryEntry | undefined, before) || value.id !== before.id || value.generation !== before.generation + 1) { tx.abort(); return; }
          const snapshots = history.getAll(historyRange(value.id));
          snapshots.onsuccess = () => { if ((snapshots.result as LibraryEntry[]).reduce((n, e) => n + historySize(e), historySize(before)) > 128 * 1024 * 1024) { tx.abort(); return; } history.add(before); apps.put(value); };
          snapshots.onerror = () => tx.abort();
        }; get.onerror = () => tx.abort();
      });
    },
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
      const tx = db.transaction(['apps', 'history'], 'readwrite'); tx.objectStore('apps').delete(id); tx.objectStore('history').delete(historyRange(id));
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    },
  };
}
async function sqlite(): Promise<Persistence> {
  const sqlite3 = await initSqlite();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: '/needware-opfs', initialCapacity: 8 });
  const db = new pool.OpfsSAHPoolDb('/library.sqlite');
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,title TEXT NOT NULL,digest TEXT NOT NULL,bytes BLOB NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL,consent INTEGER NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS history(id TEXT NOT NULL,title TEXT NOT NULL,digest TEXT NOT NULL,bytes BLOB NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL,consent INTEGER NOT NULL,PRIMARY KEY(id,generation));');
  const row = (r: Record<string, unknown>): LibraryEntry => ({ id: String(r.id), title: String(r.title), digest: String(r.digest), bytes: r.bytes as Uint8Array, state: String(r.state), generation: Number(r.generation), consent: r.consent === 1 });
  return {
    async list() { return db.selectObjects('SELECT * FROM apps').map(row); },
    async get(id) { const r = db.selectObject('SELECT * FROM apps WHERE id=?', [id]); return r ? row(r) : undefined; },
    async history(id) { return db.selectObjects('SELECT * FROM history WHERE id=? ORDER BY generation DESC', [id]).map(row); },
    async revise(value, before) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const old = db.selectObject('SELECT * FROM apps WHERE id=?', [value.id]);
        if (!same(old ? row(old) : undefined, before) || value.id !== before.id || value.generation !== before.generation + 1) throw new Error('Revision review is stale. Review again; data preserved.');
        const size = db.selectValue('SELECT COALESCE(SUM(length(bytes)+length(CAST(state AS BLOB))),0) FROM history WHERE id=?', [value.id]);
        if (Number(size) + historySize(before) > 128 * 1024 * 1024) throw new Error('Recovery history exceeds 128 MiB; export before removing this application.');
        db.exec({ sql: 'INSERT INTO history SELECT * FROM apps WHERE id=?', bind: [value.id] });
        db.exec({ sql: 'UPDATE apps SET title=?,digest=?,bytes=?,state=?,generation=?,consent=? WHERE id=?', bind: [value.title, value.digest, value.bytes, value.state, value.generation, Number(value.consent), value.id] });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async put(value, expected) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const old = db.selectObject('SELECT generation FROM apps WHERE id=?', [value.id]);
        if (Number(old?.generation ?? 0) !== expected) throw new Error('Application changed in another writer. Reopen it.');
        db.exec({ sql: 'INSERT INTO apps VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,digest=excluded.digest,bytes=excluded.bytes,state=excluded.state,generation=excluded.generation,consent=excluded.consent', bind: [value.id, value.title, value.digest, value.bytes, value.state, value.generation, Number(value.consent)] });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async delete(id) { db.exec('BEGIN IMMEDIATE'); try { db.exec({ sql: 'DELETE FROM history WHERE id=?', bind: [id] }); db.exec({ sql: 'DELETE FROM apps WHERE id=?', bind: [id] }); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } },
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
function supported(info: PackageInfo) {
  for (const screen of info.application.screens) requireSupported(screen.root);
  if (info.application.capabilities.some(c => c.kind !== 'storage' || c.synchronized)) throw new Error('This browser host currently supports local-storage applications only.');
}
function activated(next: BrowserRuntime, entry: LibraryEntry, info: PackageInfo): Loaded {
  const view = JSON.parse(next.view());
  runtime?.free(); runtime = next; current = entry; instance = crypto.randomUUID();
  return { instance, info, view, storage };
}
async function execute(command: Command): Promise<unknown> {
  await ready;
  switch (command.kind) {
    case 'example': return authored_example();
    case 'inspect': return JSON.parse(inspect_package(command.bytes)) as PackageInfo;
    case 'library': return persistence.list();
    case 'history': return persistence.history(command.id);
    case 'preview-revision': {
      pending?.source.free(); pending = undefined;
      const info = JSON.parse(inspect_package(command.bytes)) as PackageInfo; supported(info);
      const before = await persistence.get(info.application.id);
      if (!before) throw new Error('Run the source application before reviewing a revision.');
      const source = new BrowserRuntime(before.bytes, before.state, before.consent);
      try {
        const report = JSON.parse(source.preview_revision(command.bytes, command.consent));
        pending = { source, before, bytes: command.bytes, info }; return report;
      } catch (error) { source.free(); throw error; }
    }
    case 'activate-revision': {
      const review = pending; pending = undefined;
      if (!review) throw new Error('Review this revision before activation.');
      let next: BrowserRuntime | undefined;
      try {
        if (!same(await persistence.get(review.before.id), review.before)) throw new Error('Revision review is stale. Review again; data preserved.');
        next = review.source.approve_revision(command.review, command.destructive, command.permissions);
        const entry = { ...review.before, title: review.info.application.title, digest: review.info.digest, bytes: review.bytes, state: next.snapshot(), generation: review.before.generation + 1, consent: true };
        next.view(); // Rendering must succeed before the atomic durable commit.
        await persistence.revise(entry, review.before);
        const result = activated(next, entry, review.info); next = undefined; return result;
      } finally { next?.free(); review.source.free(); }
    }
    case 'rollback': {
      const before = await persistence.get(command.id);
      if (!before || before.generation !== command.expected || !command.consent) throw new Error('Rollback review is stale or consent is missing.');
      const snapshot = (await persistence.history(command.id)).find(e => e.generation === command.snapshot);
      if (!snapshot) throw new Error('Recovery snapshot unavailable.');
      const info = JSON.parse(inspect_package(snapshot.bytes)) as PackageInfo; supported(info);
      if (info.application.id !== before.id || info.digest !== snapshot.digest) throw new Error('Recovery package identity mismatch.');
      const next = new BrowserRuntime(snapshot.bytes, snapshot.state, command.consent);
      try {
        const entry = { ...snapshot, generation: before.generation + 1 }; next.view();
        await persistence.revise(entry, before); return activated(next, entry, info);
      } catch (error) { next.free(); throw error; }
    }
    case 'load': {
      const info = JSON.parse(inspect_package(command.bytes)) as PackageInfo;
      supported(info);
      const old = await persistence.get(info.application.id);
      if (old && old.digest !== info.digest) throw new Error('A different revision exists. Migration review is required; your data has been preserved.');
      const next = new BrowserRuntime(command.bytes, old?.state, command.consent);
      try {
        const entry: LibraryEntry = { id: info.application.id, title: info.application.title, digest: info.digest, bytes: command.bytes, state: next.snapshot(), generation: (old?.generation ?? 0) + 1, consent: true };
        const view = JSON.parse(next.view());
        await persistence.put(entry, old?.generation ?? 0);
        runtime?.free(); runtime = next; current = entry;
        instance = crypto.randomUUID();
        return { instance, info, view, storage } satisfies Loaded;
      } catch (error) { next.free(); throw error; }
    }
    case 'dispatch': {
      if (!runtime || !current || command.instance !== instance) throw new Error('Application instance is closed or stale. Reopen it.');
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
