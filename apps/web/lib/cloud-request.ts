import 'server-only';
import canonicalize from 'canonicalize';
import { authConfigured, authResources } from './auth-options';
import { getAuth } from './auth';

export class CloudError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const cloudResponse = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '60' } : {}) },
});
export function cloudFailure(error: unknown): Response {
  if(!(error instanceof CloudError)){
    const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:'INTERNAL';
    const constraint=error&&typeof error==='object'&&'constraint' in error&&typeof error.constraint==='string'&&/^[a-z0-9_]{1,80}$/.test(error.constraint)?error.constraint:'';
    console.error('Cloud request failed',code,constraint);
  }
  return error instanceof CloudError ? cloudResponse({ message: error.message }, error.status)
    : cloudResponse({ message: 'Cloud service temporarily unavailable' }, 503);
}
export async function accountRequest(request: Request, fresh = false) {
  if (!authConfigured()) throw new CloudError(503, 'Accounts are not configured');
  const { origin, pool } = authResources();
  const source = request.headers.get('origin');
  if ((request.method !== 'GET' && source !== origin) || (source && source !== origin)
      || request.headers.get('sec-fetch-site') === 'cross-site') throw new CloudError(403, 'Request origin is not allowed');
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user.emailVerified) throw new CloudError(401, 'Sign in with a verified email first');
  if (fresh && Date.now() - new Date(session.session.createdAt).getTime() > 15 * 60_000) {
    throw new CloudError(403, 'Sign in again before changing encryption devices');
  }
  const limited = await pool.query(`INSERT INTO needware_account_limit (account_id,count,reset_at)
    VALUES ($1,1,now()+interval '1 minute') ON CONFLICT (account_id) DO UPDATE
    SET count=CASE WHEN needware_account_limit.reset_at <= now() THEN 1 ELSE needware_account_limit.count+1 END,
    reset_at=CASE WHEN needware_account_limit.reset_at <= now() THEN now()+interval '1 minute' ELSE needware_account_limit.reset_at END
    WHERE needware_account_limit.reset_at <= now() OR needware_account_limit.count < 60 RETURNING count`, [session.user.id]);
  if (!limited.rowCount) throw new CloudError(429, 'Account request limit; try again shortly');
  return { session, pool };
}
export async function canonicalBody(request: Request, limit = 32 * 1024): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new CloudError(415, 'JSON requests are required');
  const reader = request.body?.getReader(); if (!reader) throw new CloudError(400, 'Request body is required');
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength;
    if (length > limit) { await reader.cancel(); throw new CloudError(413, 'Cloud request size limit'); }
    chunks.push(next.value);
  }
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const value: unknown = JSON.parse(raw);
    // Canonical wire JSON also rejects duplicate keys and ambiguous encodings.
    if (canonicalize(value) !== raw) throw new Error();
    return value;
  } catch { throw new CloudError(400, 'Vault request must use canonical JSON'); }
}
