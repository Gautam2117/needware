import type { WorkerReply } from './protocol';
export class WorkerHost<Command> {
  private readonly port: Worker;
  private serial = 0;
  private readonly deadline: (command: Command) => number;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(path: string, deadline: (command: Command) => number = () => 30_000) {
    this.deadline = deadline;
    this.port = new Worker(path, { type: 'module' });
    this.port.onerror = () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Runtime could not start. Reconnect to finish downloading offline support.')); } this.pending.clear(); };
    this.port.onmessage = (event: MessageEvent<WorkerReply>) => {
      const response = event.data; const request = this.pending.get(response.id);
      if (!request) return; clearTimeout(request.timer); this.pending.delete(response.id);
      if (response.ok) request.resolve(response.data); else request.reject(Object.assign(new Error(response.error ?? 'Runtime operation failed'),{retryAfter:response.retryAfter,status:response.status}));
    };
  }
  request<T>(command: Command): Promise<T> {
    const timeout = this.deadline(command);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) return Promise.reject(new Error('Invalid runtime deadline'));
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Runtime timed out. Reopen the application to recover its last durable state.')); }, timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer }); this.port.postMessage({ id, command });
    });
  }
  close(): void { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Host closed')); } this.pending.clear(); this.port.terminate(); }
}
