import { controlConfig } from '../../../lib/control';
export async function POST(request: Request) {
  const expectedOrigin = process.env.NEEDWARE_PUBLIC_ORIGIN ?? new URL(request.url).origin;
  if (request.headers.get('origin') !== expectedOrigin || request.headers.get('content-type')?.split(';')[0] !== 'application/json') return Response.json({ message: 'Request origin or content type was rejected.' }, { status: 403 });
  const config = controlConfig();
  if (!config) return Response.json({ message: 'Creation is not configured on this installation.' }, { status: 503 });
  const reader = request.body?.getReader(); if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 40 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); } chunks.push(next.value); }
  const body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  try {
    const response = await fetch(new URL('/api/compile-jobs', config.endpoint), { method: 'POST', headers: { ...config.headers, 'Content-Type': 'application/json' }, body, signal: AbortSignal.any([request.signal, AbortSignal.timeout(185_000)]), cache: 'no-store' });
    if (!response.ok) return Response.json({ message: response.status === 429 ? 'This installation is busy. Try again shortly.' : 'Creation is unavailable on this installation.' }, { status: response.status });
    return new Response(response.body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
  } catch { return Response.json({ message: 'Creation was interrupted. You can submit the request again.' }, { status: 503 }); }
}
