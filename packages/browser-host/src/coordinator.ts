import type { LibraryEntry } from './protocol';
export interface Persistence {
  list(): Promise<LibraryEntry[]>;
  get(id: string): Promise<LibraryEntry | undefined>;
  put(value: LibraryEntry, expected: number): Promise<void>;
  revise(value: LibraryEntry, before: LibraryEntry): Promise<void>;
  history(id: string): Promise<LibraryEntry[]>;
  delete(id: string): Promise<void>;
}
type Operation = { kind: 'list' } | { kind: 'get' | 'delete' | 'history'; application: string } | { kind: 'put'; entry: LibraryEntry; expected: number } | { kind: 'revise'; entry: LibraryEntry; before: LibraryEntry };
type Request = { kind: 'storage-request'; id: string; operation: Operation };
type Reply = { kind: 'storage-reply'; id: string; ok: boolean; data?: unknown; error?: string };
export async function coordinatedSqlite(factory: () => Promise<Persistence>): Promise<Persistence> {
  const bus = new BroadcastChannel('needware-opfs-coordinator-1');
  let owner: Persistence | undefined;
  let opening: Promise<void> | undefined;
  const waiters = new Map<string, (reply: Reply) => void>();
  const completed = new Map<string, Reply>();
  let queue = Promise.resolve();
  const execute = async (operation: Operation): Promise<unknown> => {
    if (!owner) throw new Error('Database leader unavailable');
    switch (operation.kind) {
      case 'list': return owner.list(); case 'get': return owner.get(operation.application);
      case 'delete': return owner.delete(operation.application); case 'put': return owner.put(operation.entry, operation.expected);
      case 'history': return owner.history(operation.application); case 'revise': return owner.revise(operation.entry, operation.before);
    }
  };
  bus.onmessage = (event: MessageEvent<Request | Reply>) => {
    const message = event.data;
    if (message.kind === 'storage-reply') { waiters.get(message.id)?.(message); return; }
    if (!owner || message.kind !== 'storage-request') return;
    queue = queue.then(async () => {
      const cached = completed.get(message.id); if (cached) { bus.postMessage(cached); return; }
      let reply: Reply;
      try { reply = { kind: 'storage-reply', id: message.id, ok: true, data: await execute(message.operation) }; }
      catch (error) { reply = { kind: 'storage-reply', id: message.id, ok: false, error: String(error) }; }
      if (message.operation.kind === 'put' || message.operation.kind === 'delete' || message.operation.kind === 'revise') { completed.set(message.id, reply); if (completed.size > 128) completed.delete(completed.keys().next().value ?? ''); }
      bus.postMessage(reply);
    });
  };
  async function elect(): Promise<void> {
    if (owner) return;
    if (opening) return opening;
    opening = new Promise<void>((resolve, reject) => {
      navigator.locks.request('needware-opfs-database-1', { ifAvailable: true }, async lock => {
        if (!lock) { resolve(); return; }
        try { owner = await factory(); resolve(); await new Promise<void>(() => { /* Lock lives until this dedicated worker terminates. */ }); }
        catch (error) { reject(error); }
      }).catch(reject);
    });
    try { await opening; } finally { opening = undefined; }
  }
  async function request(operation: Operation): Promise<unknown> {
    await elect(); if (owner) return execute(operation);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const send = () => bus.postMessage({ kind: 'storage-request', id, operation } satisfies Request);
      const interval = setInterval(send, 200);
      const timeout = setTimeout(() => { clearInterval(interval); waiters.delete(id); reject(new Error('Database coordinator timed out. Reopen to retry leader election; durable data is preserved.')); }, 10_000);
      waiters.set(id, reply => { clearInterval(interval); clearTimeout(timeout); waiters.delete(id); if (reply.ok) resolve(reply.data); else reject(new Error(reply.error)); }); send();
    });
  }
  await elect();
  return {
    list: async () => await request({ kind: 'list' }) as LibraryEntry[],
    get: async application => await request({ kind: 'get', application }) as LibraryEntry | undefined,
    put: async (entry, expected) => { await request({ kind: 'put', entry, expected }); },
    revise: async (entry, before) => { await request({ kind: 'revise', entry, before }); },
    history: async application => await request({ kind: 'history', application }) as LibraryEntry[],
    delete: async application => { await request({ kind: 'delete', application }); },
  };
}
