import { accountRequest, canonicalBody, cloudFailure, cloudResponse, CloudError } from '../../../../lib/cloud-request';
import { object } from '../../../../lib/vault-proof';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const body = object(await canonicalBody(request), ['operation']);
    if (!['create_vault', 'register_device', 'relay_document'].includes(String(body.operation))) throw new CloudError(400, 'Invalid device operation');
    const { session, pool } = await accountRequest(request, body.operation !== 'relay_document');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM auth_user WHERE id=$1 FOR UPDATE', [session.user.id]);
      await client.query('DELETE FROM needware_vault_challenge WHERE account_id=$1 AND expires_at <= now()', [session.user.id]);
      const existing = await client.query('SELECT count(*)::integer AS total FROM needware_vault_challenge WHERE account_id=$1', [session.user.id]);
      if (existing.rows[0].total >= 10) throw new CloudError(429, 'Too many pending device challenges');
      const result = await client.query('INSERT INTO needware_vault_challenge (account_id,session_id,operation) VALUES ($1,$2,$3) RETURNING id,expires_at',
        [session.user.id, session.session.id, body.operation]);
      await client.query('COMMIT'); return cloudResponse({ nonce: result.rows[0].id, expiresAt: result.rows[0].expires_at });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } catch (error) { return cloudFailure(error); }
}
