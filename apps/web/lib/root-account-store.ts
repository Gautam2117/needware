import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import { CloudError } from './cloud-request';
import { binding, positive, type Binding } from './document-proof';
import { bytes, object, recovery, uuid, type Certificate, type Context } from './vault-proof';
import { rootRotation, type RootRotation } from './root-rotation-proof';
import { retainedRootDevices, type RootDevice, type RegisteredRootDevice } from './root-rotation-devices';
import type { RelayDocument } from './document-epoch-store';
export type RootSource={document:string;binding:Binding;cursor:string;history:{generation:number;held:unknown}[]};
export type RootIntent={account_id:string;id:string;status:'staging'|'active';actor_device:string;proof:RootRotation;recovery:unknown;devices:RootDevice[];sources:RootSource[];metadata_bytes:number};
export type RootEpochAccess={intent:RootIntent;owner:Certificate;activate:boolean};
const same=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
const size=(value:unknown)=>Buffer.byteLength(canonicalize(value)!);
export const ROOT_PUBLICATION_LOCK="SELECT pg_advisory_xact_lock(hashtextextended('needware-root-publication-v1',0))";
export const ROOT_RELAY_LOCK="SELECT pg_advisory_xact_lock_shared(hashtextextended('needware-root-publication-v1',0))";
export async function rootAccountCharge(client:PoolClient,account:string,amount:number):Promise<void>{
  await client.query('INSERT INTO needware_relay_usage(account_id) VALUES($1) ON CONFLICT DO NOTHING',[account]);
  const charged=await client.query('UPDATE needware_relay_usage SET bytes=bytes+$2 WHERE account_id=$1 AND bytes+$2 BETWEEN 0 AND 134217728 RETURNING account_id',[account,amount]);
  if(!charged.rowCount)throw new CloudError(409,'Account root rotation storage quota exceeded');
}
export function rootHistoryKey(value:unknown,document:Binding['document'],rotation:RootRotation):unknown{
  const held=object(value,['document','holder','authority','ciphertext']);bytes(held.ciphertext,72);
  if(!same(held.document,document)||!same(held.holder,rotation.transition.next)||!same(held.authority,rotation.transition.next_authority))throw new CloudError(403,'Historical key is not wrapped for the new account root');
  return held;
}
export async function loadRootIntent(client:PoolClient,account:string,id:string):Promise<RootIntent>{
  const result=await client.query<RootIntent>('SELECT * FROM needware_root_rotation WHERE account_id=$1 AND id=$2 FOR UPDATE',[account,uuid(id)]);
  if(!result.rowCount)throw new CloudError(404,'Account root rotation unavailable');return result.rows[0];
}
export async function rootEpochAccess(client:PoolClient,doc:RelayDocument,actor:Certificate,id:string,activate=false):Promise<RootEpochAccess>{
  const intent=await loadRootIntent(client,actor.context.account,id);
  if(intent.status!=='staging'||intent.actor_device!==actor.device.id||doc.owner_id!==actor.context.account)throw new CloudError(403,'Original root staging device required');
  rootRotation(intent.proof,actor.context,doc.authority);
  const source=intent.sources.find(item=>item.document===doc.id);
  if(!source||!same(source.binding,doc.binding)||Number(source.cursor)!==Number(doc.next_sequence)||Number(doc.root_epoch)!==actor.context.epoch)throw new CloudError(409,'Account root source changed; originals preserved');
  const owner=intent.devices.find(item=>item.certificate.device.id===actor.device.id)!.certificate;
  return {intent,owner,activate};
}

/** Caller holds the publication lock and has authenticated the current device. */
export async function stageRootIntent(client:PoolClient,actor:Certificate,payload:Record<string,unknown>,current:{context:Context;authority:Buffer}):Promise<RootIntent>{
  object(payload,['action','id','proof','recovery','devices','sources']);const id=uuid(payload.id),account=actor.context.account;
  const proof=rootRotation(payload.proof,current.context,current.authority);
  const registered=await client.query<RegisteredRootDevice>('SELECT certificate,label FROM needware_vault_device WHERE account_id=$1 ORDER BY device_id FOR UPDATE',[account]);
  const devices=retainedRootDevices(payload.devices,proof,actor,registered.rows),owner=devices.find(item=>item.certificate.device.id===actor.device.id)!;
  const envelope=recovery(payload.recovery,owner.certificate);
  if(!Array.isArray(payload.sources)||payload.sources.length>256)throw new CloudError(400,'Invalid owned document cut');
  const documents=await client.query('SELECT id,binding,authority,root_epoch,next_sequence,ready FROM needware_document WHERE owner_id=$1 ORDER BY id FOR UPDATE',[account]);
  if(documents.rowCount!==payload.sources.length)throw new CloudError(409,'Every owned cloud document must participate in root rotation');
  const sources:RootSource[]=[],seen=new Set<string>();
  for(const value of payload.sources){
    const raw=object(value,['document','binding','cursor','history']),document=uuid(raw.document),before=binding(raw.binding,document),source=documents.rows.find(item=>item.id===document);
    if(seen.has(document))throw new CloudError(400,'Duplicate owned root cut');seen.add(document);
    if(!source||!source.ready||!source.authority.equals(current.authority)||Number(source.root_epoch)!==current.context.epoch||!same(source.binding,before)||typeof raw.cursor!=='string'||!/^(0|[1-9][0-9]{0,5})$/.test(raw.cursor)||Number(source.next_sequence)!==Number(raw.cursor))throw new CloudError(409,'Owned source changed; preserve and review another root cut');
    const epochs=await client.query('SELECT generation,binding,status FROM needware_document_epoch WHERE document_id=$1 ORDER BY generation FOR UPDATE',[document]);
    if(epochs.rows.some(item=>item.status==='staging'))throw new CloudError(409,'Finish or cancel document rotation before rotating the account root');
    const historical=epochs.rows.filter(item=>item.status==='archived').map(item=>({generation:Number(item.generation),binding:item.binding}));historical.push({generation:before.generation,binding:before});
    if(!Array.isArray(raw.history)||raw.history.length!==historical.length||raw.history.length>5)throw new CloudError(400,'Every historical document key must be retained under the new root');
    const history:{generation:number;held:unknown}[]=[],generations=new Set<number>();
    for(const entry of raw.history){const item=object(entry,['generation','held']),generation=positive(item.generation),previous=historical.find(cut=>cut.generation===generation);if(generations.has(generation)||!previous)throw new CloudError(400,'Invalid historical document generation');generations.add(generation);history.push({generation,held:rootHistoryKey(item.held,previous.binding.document,proof)});}
    history.sort((a,b)=>a.generation-b.generation);sources.push({document,binding:before,cursor:raw.cursor,history});
  }
  sources.sort((a,b)=>a.document.localeCompare(b.document));
  const prior=await client.query<RootIntent>('SELECT * FROM needware_root_rotation WHERE account_id=$1 AND id=$2',[account,id]);
  if(prior.rowCount){const row=prior.rows[0];if(row.status!=='staging'||row.actor_device!==actor.device.id||!same(row.proof,proof)||!same(row.recovery,envelope)||!same(row.devices,devices)||!same(row.sources,sources))throw new CloudError(409,'Immutable account root intent differs');return row;}
  const existing=await client.query('SELECT status FROM needware_root_rotation WHERE account_id=$1 FOR UPDATE',[account]);
  if(existing.rows.some(row=>row.status==='staging')||existing.rowCount!>=4)throw new CloudError(409,'Account root intent or retained-root limit reached');
  const metadata=size(proof)+size(envelope)+size(devices)+size(sources);if(metadata>3*1024*1024)throw new CloudError(413,'Account root intent size limit');
  await rootAccountCharge(client,account,metadata);
  const result=await client.query<RootIntent>(`INSERT INTO needware_root_rotation(account_id,id,status,actor_device,proof,recovery,devices,sources,metadata_bytes)
    VALUES($1,$2,'staging',$3,$4,$5,$6,$7,$8) RETURNING *`,[account,id,actor.device.id,proof,envelope,JSON.stringify(devices),JSON.stringify(sources),metadata]);return result.rows[0];
}
