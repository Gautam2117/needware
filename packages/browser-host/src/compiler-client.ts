import type { CompileMessage } from '@needware/ir-types/CompileMessage';
import type { StageEvent } from '@needware/ir-types/StageEvent';
export async function createApplication(prompt: string, signal: AbortSignal, progress: (event: StageEvent) => void): Promise<Uint8Array> {
  const response = await fetch('/api/compile-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }), signal });
  if (!response.ok) { const error = await response.json().catch(() => ({})) as { message?: string }; throw new Error(error.message ?? 'Creation did not finish.'); }
  if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('Invalid compiler response.');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.length; if (total > 8 * 1024 * 1024) throw new Error('Compiler response exceeds its size limit.');
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const end = buffer.indexOf('\n\n'); if (end < 0) break;
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const message = JSON.parse(data) as CompileMessage;
        if (message.kind === 'stage') progress(message.event);
        else if (message.kind === 'error') throw new Error(message.message);
        else if (message.kind === 'package') {
          if (typeof message.package_base64 !== 'string' || message.package_base64.length > 4 * 1024 * 1024) throw new Error('Invalid generated package.');
          return Uint8Array.from(atob(message.package_base64), char => char.charCodeAt(0));
        } else throw new Error('Unknown compiler message.');
      }
    }
    throw new Error('Creation was interrupted before a verified package arrived.');
  } finally { await reader.cancel(); }
}
