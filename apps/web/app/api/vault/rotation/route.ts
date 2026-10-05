import canonicalize from 'canonicalize';
import { accountRequest, canonicalBody, cloudFailure, cloudResponse, CloudError } from '../../../../lib/cloud-request';
import { object, operationProof, uuid } from '../../../../lib/vault-proof';
import { activateRootIntent, cancelRootIntent } from '../../../../lib/root-account-publication';
import { loadRootIntent, ROOT_PUBLICATION_LOCK, ROOT_RELAY_LOCK, stageRootIntent } from '../../../../lib/root-account-store';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(request:Request){
  try{
    const body=object(await canonicalBody(request,3*1024*1024),['proof','payload']),payload=body.payload as Record<string,unknown>;
    if(!payload||!['prepare','activate','cancel','status'].includes(String(payload.action)))throw new CloudError(400,'Invalid account root operation');
    const {session,pool}=await accountRequest(request,payload.action!=='status'),proof=operationProof(body.proof,session.user.id,payload);
    if(proof.operation!=='rotate_root')throw new CloudError(400,'Account root operation proof required');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query(payload.action==='status'?ROOT_RELAY_LOCK:ROOT_PUBLICATION_LOCK);
      await client.query('SELECT id FROM auth_user WHERE id=$1 FOR SHARE',[session.user.id]);
      const registered=await client.query(`SELECT v.context,v.authority,d.certificate FROM needware_account_vault v JOIN needware_vault_device d
        ON d.account_id=v.account_id WHERE v.account_id=$1 AND d.device_id=$2 FOR UPDATE OF v,d`,[session.user.id,proof.certificate.device.id]);
      if(!registered.rowCount||!registered.rows[0].authority.equals(Buffer.from(proof.certificate.authority))||canonicalize(registered.rows[0].context)!==canonicalize(proof.certificate.context)||canonicalize(registered.rows[0].certificate)!==canonicalize(proof.certificate))throw new CloudError(403,'Current trusted encryption device required');
      const nonce=await client.query("DELETE FROM needware_vault_challenge WHERE id=$1 AND account_id=$2 AND session_id=$3 AND operation='rotate_root' AND expires_at>now() RETURNING id",[proof.nonce,session.user.id,session.session.id]);
      if(!nonce.rowCount)throw new CloudError(403,'Account root challenge expired or consumed');
      const id=uuid(payload.id),current=registered.rows[0];let result:unknown;
      if(payload.action==='prepare'){const intent=await stageRootIntent(client,proof.certificate,payload,current);result={id,status:intent.status};}
      else{
        object(payload,['action','id']);
        if(payload.action==='cancel'){await cancelRootIntent(client,proof.certificate,id,current);result={id,cancelled:true};}
        else{const intent=payload.action==='activate'?await activateRootIntent(client,proof.certificate,id,current):await loadRootIntent(client,session.user.id,id);
          const pending=await client.query('SELECT document_id,generation FROM needware_document_rekey WHERE account_id=$1 AND rotation_id=$2 ORDER BY document_id',[session.user.id,id]);
          result={id,status:intent.status,proof:intent.proof,sources:intent.sources.map(source=>({document:source.document,binding:source.binding,cursor:source.cursor})),pending_owner_rekeys:pending.rows};}
      }
      await client.query('COMMIT');return cloudResponse(result);
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }catch(error){return cloudFailure(error);}
}
