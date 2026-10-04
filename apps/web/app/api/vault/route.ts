import canonicalize from 'canonicalize';
import { accountRequest, canonicalBody, cloudFailure, cloudResponse, CloudError } from '../../../lib/cloud-request';
import { object, operationProof, recovery } from '../../../lib/vault-proof';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const { session, pool } = await accountRequest(request);
    const roots = await pool.query('SELECT context,authority,recovery,created_at FROM needware_account_vault WHERE account_id=$1', [session.user.id]);
    if (!roots.rowCount) return cloudResponse({ vault: null });
    const devices = await pool.query('SELECT device_id,label,certificate,created_at FROM needware_vault_device WHERE account_id=$1 ORDER BY created_at', [session.user.id]);
    return cloudResponse({ vault: { context: roots.rows[0].context, authority: roots.rows[0].authority.toString('hex'),
      recovery: roots.rows[0].recovery, devices: devices.rows } });
  } catch (error) { return cloudFailure(error); }
}
export async function POST(request: Request) {
  try {
    const { session, pool } = await accountRequest(request, true);
    const body = object(await canonicalBody(request), ['proof', 'payload']);
    const proof = operationProof(body.proof, session.user.id, body.payload);
    if (proof.operation === 'relay_document') throw new CloudError(400, 'Use the document relay for this operation');
    const payload = object(body.payload, proof.operation === 'create_vault' ? ['label', 'recovery'] : ['label']);
    if (typeof payload.label !== 'string' || !payload.label.trim() || payload.label.length > 80) throw new CloudError(400, 'Device name must have 1 to 80 characters');
    const envelope = proof.operation === 'create_vault' ? recovery(payload.recovery, proof.certificate) : undefined;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One account lock serializes first-root pinning, enrollment and device limits.
      await client.query('SELECT id FROM auth_user WHERE id=$1 FOR UPDATE', [session.user.id]);
      const nonce = await client.query(`DELETE FROM needware_vault_challenge WHERE id=$1 AND account_id=$2 AND session_id=$3
        AND operation=$4 AND expires_at > now() RETURNING id`, [proof.nonce, session.user.id, session.session.id, proof.operation]);
      if (!nonce.rowCount) throw new CloudError(403, 'Device challenge expired, consumed or belongs to another session');
      const roots = await client.query('SELECT context,authority FROM needware_account_vault WHERE account_id=$1', [session.user.id]);
      if (proof.operation === 'create_vault') {
        if (roots.rowCount) throw new CloudError(409, 'Account encryption root is already pinned; use recovery or device enrollment');
        if (proof.certificate.context.epoch !== 1) throw new CloudError(400, 'Initial root epoch must be 1');
        await client.query('INSERT INTO needware_account_vault (account_id,context,authority,root_epoch,recovery) VALUES ($1,$2,$3,$4,$5)',
          [session.user.id, proof.certificate.context, Buffer.from(proof.certificate.authority), 1, envelope]);
      } else {
        if (!roots.rowCount || !roots.rows[0].authority.equals(Buffer.from(proof.certificate.authority))
            || canonicalize(roots.rows[0].context) !== canonicalize(proof.certificate.context)) throw new CloudError(403, 'Device is not approved by the pinned account root');
      }
      const count = await client.query('SELECT count(*)::integer AS total FROM needware_vault_device WHERE account_id=$1', [session.user.id]);
      if (count.rows[0].total >= 10) throw new CloudError(409, 'Account encryption-device limit reached');
      const added = await client.query(`INSERT INTO needware_vault_device (account_id,device_id,certificate,label)
        VALUES ($1,$2,$3,$4) ON CONFLICT (account_id,device_id) DO NOTHING RETURNING device_id`,
      [session.user.id, proof.certificate.device.id, proof.certificate, payload.label]);
      if (!added.rowCount) throw new CloudError(409, 'Encryption device is already registered');
      await client.query('COMMIT');
      return cloudResponse({ device: proof.certificate.device.id }, 201);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } catch (error) { return cloudFailure(error); }
}
