import { controlConfig } from '../../../lib/control';
export async function GET() {
  const config = controlConfig();
  if (!config) return Response.json({ provider: null }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const response = await fetch(new URL('/api/providers', config.endpoint), { headers: config.headers, cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Provider configuration unavailable');
    return new Response(await response.text(), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ provider: null }, { headers: { 'Cache-Control': 'no-store' } }); }
}
