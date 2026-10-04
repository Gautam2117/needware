import type { WorkerReply } from './protocol';
export class WorkerHost<Command> {
  private readonly port: Worker;
  private serial = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(path: string) {
    this.port = new Worker(path, { type: 'module' });
    this.port.onerror = () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Runtime could not start. Reconnect to finish downloading offline support.')); } this.pending.clear(); };
    this.port.onmessage = (event: MessageEvent<WorkerReply>) => {
      const response = event.data; const request = this.pending.get(response.id);
      if (!request) return; clearTimeout(request.timer); this.pending.delete(response.id);
      if (response.ok) request.resolve(response.data); else request.reject(Object.assign(new Error(response.error ?? 'Runtime operation failed'),{retryAfter:response.retryAfter,status:response.status}));
    };
  }
  request<T>(command: Command): Promise<T> {
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Runtime timed out. Reopen the application to recover its last durable state.')); }, 30_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer }); this.port.postMessage({ id, command });
    });
  }
  close(): void { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Host closed')); } this.pending.clear(); this.port.terminate(); }
}
