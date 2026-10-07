import { getAuth } from '../../../../lib/auth';
import { accountEmailStatus, authConfigured, authResources } from '../../../../lib/auth-options';
import {trustedClientAddress} from '../../../../lib/ingress';
import {after} from 'next/server';
import {runMailWorker} from '../../../../../../scripts/mail-worker.mjs';
export const runtime = 'nodejs';
const fail = (message: string, status: number) => Response.json({ message }, { status, headers: { 'Cache-Control': 'no-store' } });
async function handle(request: Request) {
  if (!authConfigured()) return fail('Account service is not configured on this installation', 503);
  try {
    const { origin } = authResources();
    if (request.method === 'POST' && request.headers.get('origin') !== origin) return fail('Request origin is not allowed', 403);
    const headers = new Headers(request.headers);
    // Never accept the caller's internal rate-limit identity header.
    headers.delete('x-needware-auth-ip');
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname);
    const ip = trustedClientAddress(headers);
    headers.set('x-needware-auth-ip', ip || (local ? '127.0.0.1' : '0.0.0.0'));
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (request.method === 'POST') {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return fail('JSON requests are required', 415);
      const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      if (reader) for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 64 * 1024) { await reader.cancel(); return fail('Account request size limit', 413); }
        chunks.push(value);
      }
      body = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      headers.delete('content-length');
    }
    const status: {failed:boolean;queued?:boolean} = { failed: false };
    const response = await accountEmailStatus.run(status, () => getAuth().handler(new Request(request.url, { method: request.method, headers, body })));
    if (status.failed) return fail('Account email temporarily unavailable; retry later', 503);
    if (status.queued && response.ok && process.env.NEEDWARE_MAIL_DISPATCH_MODE === 'scheduled') after(async () => {
      try { await runMailWorker({once:true,reuseResources:true}); }
      catch { console.error('Bounded account mail dispatch failed; durable retry remains queued'); }
    });
    response.headers.set('Cache-Control', 'no-store'); return response;
  } catch { return fail('Account service temporarily unavailable', 503); }
}
export const GET = handle;
export const POST = handle;
