import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import { CloudError } from './cloud-request';
import { epochAction, type RelayDocument } from './document-epoch-store';
import { membership } from './document-proof';
import { charge, encodedSize, envelope } from './relay-storage';
import { loadRootIntent, rootAccountCharge, rootEpochAccess, type RootIntent } from './root-account-store';
import { rootRotation } from './root-rotation-proof';
import type { Certificate, Context } from './vault-proof';
const same=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
type CurrentRoot={context:Context;authority:Buffer};

/** All callers hold the exclusive publication lock before acquiring row locks. */
export async function activateRootIntent(client:PoolClient,actor:Certificate,id:string,current:CurrentRoot):Promise<RootIntent>{
  const account=actor.context.account,intent=await loadRootIntent(client,account,id);
  if(intent.status==='active'){
    if(!same(current.context,intent.proof.transition.next)||!current.authority.equals(Buffer.from(intent.proof.transition.next_authority)))throw new CloudError(409,'Account root publication was superseded');return intent;
  }
  if(intent.actor_device!==actor.device.id)throw new CloudError(403,'Original account root staging device required');
  rootRotation(intent.proof,current.context,current.authority);
  const devices=await client.query('SELECT device_id,certificate FROM needware_vault_device WHERE account_id=$1 ORDER BY device_id FOR UPDATE',[account]);
  for(const target of intent.devices){const old=devices.rows.find(device=>device.device_id===target.certificate.device.id);if(!old||!same(old.certificate.device,target.certificate.device)||!same(old.certificate.context,current.context)||!same(old.certificate.authority,Array.from(current.authority)))throw new CloudError(409,'Trusted device changed; preserve and review another root cut');}
  const documents=await client.query<RelayDocument>('SELECT * FROM needware_document WHERE owner_id=$1 ORDER BY id FOR UPDATE',[account]);
  if(documents.rowCount!==intent.sources.length||documents.rows.some(doc=>!intent.sources.some(source=>source.document===doc.id)))throw new CloudError(409,'Owned document set changed; originals preserved');
  const cuts=[];
  for(const doc of documents.rows){
    const staged=await client.query('SELECT status,root_rotation_id FROM needware_document_epoch WHERE document_id=$1 AND generation=$2 FOR UPDATE',[doc.id,doc.binding.generation+1]);
    if(!staged.rowCount||staged.rows[0].status!=='staging'||staged.rows[0].root_rotation_id!==id)throw new CloudError(409,'Stage every owned document cut before publishing the account root');
    const access=await rootEpochAccess(client,doc,actor,id,true),oldGrant=await client.query('SELECT membership FROM needware_document_member WHERE document_id=$1 AND account_id=$2 AND device_id=$3 AND NOT revoked',[doc.id,account,actor.device.id]);
    if(!oldGrant.rowCount)throw new CloudError(409,'Original owner write grant changed');
    const grant=membership(oldGrant.rows[0].membership,doc.binding,doc.authority,Number(doc.root_epoch));
    cuts.push({doc,access,grant});
  }
  // Preserve original author identity before changing certificate rows or
  // cascading excluded devices. Foreign keys remain cryptographically stale
  // until their owner publishes a fresh generation, so pause those documents.
  const foreign=await client.query(`SELECT d.id,d.owner_id,d.binding,m.device_id,m.membership,m.key_envelope,v.certificate
    FROM needware_document d JOIN needware_document_member m ON m.document_id=d.id
    JOIN needware_vault_device v ON v.account_id=m.account_id AND v.device_id=m.device_id
    WHERE m.account_id=$1 AND d.owner_id<>$1 AND NOT m.revoked ORDER BY d.id,m.device_id FOR UPDATE OF d,m`,[account]);
  for(const source of foreign.rows){
    const bytes=encodedSize(source.certificate)+encodedSize(source.membership)+encodedSize(source.key_envelope);
    const saved=await client.query(`INSERT INTO needware_document_retained_author(document_id,generation,account_id,device_id,certificate,membership,key_envelope,metadata_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING device_id`,[source.id,source.binding.generation,account,source.device_id,source.certificate,source.membership,source.key_envelope,bytes]);
    if(saved.rowCount)await charge(client,source,bytes);
    await client.query(`INSERT INTO needware_document_rekey(document_id,generation,account_id,rotation_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(document_id,account_id) DO UPDATE SET generation=EXCLUDED.generation,rotation_id=EXCLUDED.rotation_id`,[source.id,source.binding.generation,account,id]);
  }
  const next=intent.proof.transition.next,authority=Buffer.from(intent.proof.transition.next_authority);
  await client.query('UPDATE needware_account_vault SET context=$2,authority=$3,root_epoch=$4,recovery=$5 WHERE account_id=$1',[account,next,authority,next.epoch,intent.recovery]);
  for(const device of intent.devices)await client.query('UPDATE needware_vault_device SET certificate=$3,root_approval=$4,root_rotation_proof=$5 WHERE account_id=$1 AND device_id=$2',[account,device.certificate.device.id,device.certificate,device.approval,intent.proof]);
  for(const cut of cuts){
    await epochAction(client,cut.doc,{action:'epoch_activate',document:cut.doc.id,generation:cut.doc.binding.generation+1,root_rotation:id},{account,device:actor.device.id,certificate:actor,owner:true,grant:cut.grant},charge,envelope,cut.access);
    const source=intent.sources.find(source=>source.document===cut.doc.id)!;
    for(const historical of source.history){
      const before=await client.query('SELECT metadata_bytes FROM needware_document_history_key WHERE document_id=$1 AND generation=$2 FOR UPDATE',[cut.doc.id,historical.generation]);
      const bytes=encodedSize(historical.held);await charge(client,cut.doc,bytes-(before.rows[0]?.metadata_bytes??0));
      await client.query(`INSERT INTO needware_document_history_key(document_id,generation,held,metadata_bytes) VALUES($1,$2,$3,$4)
        ON CONFLICT(document_id,generation) DO UPDATE SET held=EXCLUDED.held,metadata_bytes=EXCLUDED.metadata_bytes`,[cut.doc.id,historical.generation,historical.held,bytes]);
    }
  }
  await client.query('DELETE FROM needware_vault_device WHERE account_id=$1 AND NOT(device_id=ANY($2::uuid[]))',[account,intent.devices.map(device=>device.certificate.device.id)]);
  await client.query('DELETE FROM needware_vault_challenge WHERE account_id=$1',[account]);
  await client.query("UPDATE needware_root_rotation SET status='active' WHERE account_id=$1 AND id=$2",[account,id]);
  return {...intent,status:'active'};
}

export async function cancelRootIntent(client:PoolClient,actor:Certificate,id:string,current:CurrentRoot):Promise<void>{
  const account=actor.context.account,intent=await loadRootIntent(client,account,id);
  if(intent.status!=='staging'||intent.actor_device!==actor.device.id)throw new CloudError(409,'Only the original staged account root can be cancelled');
  rootRotation(intent.proof,current.context,current.authority);
  const staged=await client.query<RelayDocument&{staged_bytes:string;generation:number}>(`SELECT d.*,e.storage_bytes AS staged_bytes,e.generation FROM needware_document d
    JOIN needware_document_epoch e ON e.document_id=d.id WHERE d.owner_id=$1 AND e.root_rotation_id=$2 AND e.status='staging' ORDER BY d.id FOR UPDATE OF d,e`,[account,id]);
  for(const row of staged.rows){await charge(client,row,-Number(row.staged_bytes));await client.query('DELETE FROM needware_document_epoch WHERE document_id=$1 AND generation=$2',[row.id,row.generation]);}
  await rootAccountCharge(client,account,-intent.metadata_bytes);await client.query('DELETE FROM needware_root_rotation WHERE account_id=$1 AND id=$2',[account,id]);
}
