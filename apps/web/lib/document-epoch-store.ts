import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {PoolClient} from 'pg';
import {CloudError} from './cloud-request';
import {object,certificate,uuid} from './vault-proof';
import {binding,ciphertext,membership,positive,transition,type Binding,type Membership} from './document-proof';
import type {RootEpochAccess} from './root-account-store';
export type RelayDocument = {id:string;owner_id:string;binding:Binding;authority:Buffer;root_epoch:number;descriptor:Record<string,unknown>;package_digest:string;package_bytes:number;ready:boolean;storage_bytes:string;next_sequence:string};
type Member = {account_id:string;device_id:string;membership:Membership;key_envelope:unknown;metadata_bytes:number;certificate?:ReturnType<typeof certificate>};
type Epoch = {generation:string;status:string;binding:Binding;previous_binding:Binding|null;descriptor:Record<string,unknown>;root_epoch:string;authority:Buffer;transition:unknown;checkpoint_manifest:Manifest|null;source_cursor:string;owner_account:string;owner_device:string;members:Member[];recipient_certificates:ReturnType<typeof certificate>[];storage_bytes:string;root_rotation_id:string|null;root_rotation_proof:unknown};
type Manifest = {digest:string;bytes:number};
type Identity = {account:string;device:string;certificate:ReturnType<typeof certificate>;owner:boolean;grant:Membership|undefined};
type Charge = (client:PoolClient,doc:RelayDocument,amount:number)=>Promise<void>;
type Envelope = (value:unknown,grant:Membership,recipient:ReturnType<typeof certificate>)=>void;
const same = (a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
const size = (value:unknown)=>Buffer.byteLength(canonicalize(value)!);
function manifest(value:unknown,max:number):Manifest {
  const fields=object(value,['digest','bytes']);
  if(typeof fields.digest!=='string'||!/^[0-9a-f]{64}$/.test(fields.digest)||!Number.isInteger(fields.bytes)||Number(fields.bytes)<40||Number(fields.bytes)>max)throw new CloudError(400,'Invalid encrypted epoch manifest');
  return fields as Manifest;
}
async function epoch(client:PoolClient,doc:RelayDocument,generation:number):Promise<Epoch> {
  const result=await client.query<Epoch>('SELECT * FROM needware_document_epoch WHERE document_id=$1 AND generation=$2 FOR UPDATE',[doc.id,generation]);
  if(!result.rowCount)throw new CloudError(404,'Document epoch unavailable');return result.rows[0];
}
function writer(identity:Identity):void {if(!identity.owner||identity.grant?.role!=='write')throw new CloudError(403,'Current owner write grant required');}
async function verifyChunks(client:PoolClient,doc:RelayDocument,row:Epoch,kind:string,expected:Manifest):Promise<void> {
  const result=await client.query('SELECT chunk_index,octet_length(ciphertext) AS bytes FROM needware_document_epoch_chunk WHERE document_id=$1 AND generation=$2 AND kind=$3 ORDER BY chunk_index',[doc.id,row.generation,kind]);
  const count=Math.ceil(expected.bytes/1048576),digest=createHash('sha256');let length=0;
  if(result.rowCount!==count)throw new CloudError(409,'Encrypted epoch upload incomplete');
  for(let index=0;index<count;index++){if(result.rows[index].chunk_index!==index||result.rows[index].bytes!==Math.min(1048576,expected.bytes-index*1048576))throw new CloudError(409,'Encrypted epoch chunk missing or truncated');
    const chunk=await client.query('SELECT ciphertext FROM needware_document_epoch_chunk WHERE document_id=$1 AND generation=$2 AND kind=$3 AND chunk_index=$4',[doc.id,row.generation,kind,index]);
    digest.update(chunk.rows[0].ciphertext);length+=chunk.rows[0].ciphertext.length;}
  if(length!==expected.bytes||digest.digest('hex')!==expected.digest)throw new CloudError(409,'Encrypted epoch manifest mismatch');
}
export async function readEpoch(client:PoolClient,doc:RelayDocument):Promise<unknown> {
  const result=await client.query('SELECT previous_binding,transition,checkpoint_manifest,root_rotation_proof AS root_rotation FROM needware_document_epoch WHERE document_id=$1 AND generation=$2 AND status=\'active\'',[doc.id,doc.binding.generation]);
  return result.rowCount?result.rows[0]:null;
}
export async function epochAction(client:PoolClient,doc:RelayDocument,payload:Record<string,unknown>,identity:Identity,charge:Charge,envelope:Envelope,root?:RootEpochAccess):Promise<unknown> {
  const action=payload.action;
  if(action==='epoch_history'){
    object(payload,['action','document']);if(!identity.owner)throw new CloudError(403,'Pinned document owner required');
    const history=await client.query("SELECT generation,binding FROM needware_document_epoch WHERE document_id=$1 AND status='archived' ORDER BY generation LIMIT 5",[doc.id]);
    return {epochs:history.rows};
  }
  const rootFields=root?['root_rotation']:[],owner=root?.owner??identity.certificate,authority=root?Buffer.from(owner.authority):doc.authority,rootEpoch=root?owner.context.epoch:Number(doc.root_epoch);
  if(action==='epoch_prepare'){
    object(payload,['action','document','descriptor','transition','checkpoint','source_cursor','membership','key_envelope',...('recipients' in payload?['recipients']:[]),...rootFields]);writer(identity);
    if(!doc.ready)throw new CloudError(409,'Current encrypted package is incomplete');
    const descriptor=object(payload.descriptor,['binding','configuration','package_digest','package_bytes']);
    const next=binding(descriptor.binding,doc.id);manifest({digest:descriptor.package_digest,bytes:descriptor.package_bytes},33554472);ciphertext(descriptor.configuration,40,32768);
    const proof=transition(payload.transition,doc.binding,next,owner.context,authority);
    const checkpoint=manifest(payload.checkpoint,16777256);
    if(typeof payload.source_cursor!=='string'||!/^(0|[1-9][0-9]{0,5})$/.test(payload.source_cursor)||Number(payload.source_cursor)!==Number(doc.next_sequence))throw new CloudError(409,'Source history changed; pull and review before preparing another cut');
    const grant=membership(payload.membership,next,authority,rootEpoch);
    if(grant.role!=='write'||!same(grant.device,owner.device))throw new CloudError(403,'Fresh owner device grant required');envelope(payload.key_envelope,grant,owner);
    const members:Member[]=[{account_id:identity.account,device_id:identity.device,membership:grant,key_envelope:payload.key_envelope,metadata_bytes:size(grant)+size(payload.key_envelope)}];
    const recipients=payload.recipients??[];
    if(!Array.isArray(recipients)||recipients.length>255)throw new CloudError(400,'Invalid retained epoch recipient list');
    const identities=new Set([`${identity.account}:${identity.device}`]);
    for(const value of recipients){
      const item=object(value,['recipient','membership','key_envelope']),target=item.recipient as Record<string,unknown>;
      const recipient=certificate(target,uuid((target?.context as Record<string,unknown>)?.account));
      const id=`${recipient.context.account}:${recipient.device.id}`;
      if(identities.has(id))throw new CloudError(400,'Duplicate retained epoch recipient');identities.add(id);
      const registered=await client.query('SELECT d.certificate,v.context,v.authority FROM needware_vault_device d JOIN needware_account_vault v ON v.account_id=d.account_id WHERE d.account_id=$1 AND d.device_id=$2',[recipient.context.account,recipient.device.id]);
      const retainedOwner=root&&recipient.context.account===identity.account;
      if(retainedOwner){const selected=root.intent.devices.find(device=>same(device.certificate,recipient));if(!selected||!registered.rowCount||!same(registered.rows[0].certificate.device,recipient.device)||!same(registered.rows[0].context,root.intent.proof.transition.previous)||!registered.rows[0].authority.equals(Buffer.from(root.intent.proof.transition.previous_authority)))throw new CloudError(403,'Root recipient was not explicitly retained');}
      else if(!registered.rowCount||!same(registered.rows[0].certificate,recipient)||!same(registered.rows[0].context,recipient.context)||!registered.rows[0].authority.equals(Buffer.from(recipient.authority)))throw new CloudError(403,'Retained recipient device is not current');
      const issued=membership(item.membership,next,authority,rootEpoch);
      if(!same(issued.device,recipient.device))throw new CloudError(403,'Retained epoch recipient mismatch');envelope(item.key_envelope,issued,recipient);
      members.push({account_id:recipient.context.account,device_id:recipient.device.id,membership:issued,key_envelope:item.key_envelope,metadata_bytes:size(issued)+size(item.key_envelope),certificate:recipient});
    }
    members.splice(1,members.length-1,...members.slice(1).sort((a,b)=>`${a.account_id}:${a.device_id}`.localeCompare(`${b.account_id}:${b.device_id}`)));
    const prior=await client.query<Epoch>('SELECT * FROM needware_document_epoch WHERE document_id=$1 AND generation=$2',[doc.id,next.generation]);
    if(prior.rowCount){const row=prior.rows[0];if(row.status!=='staging'||row.root_rotation_id!==(root?.intent.id??null)||!same(row.descriptor,descriptor)||!same(row.transition,proof)||!same(row.checkpoint_manifest,checkpoint)||!same(row.members,members)||Number(row.source_cursor)!==Number(payload.source_cursor))throw new CloudError(409,'Existing epoch intent differs');return {generation:next.generation,status:'staging'};}
    const count=await client.query('SELECT count(*)::integer AS total FROM needware_document_epoch WHERE document_id=$1 AND status IN (\'staging\',\'archived\')',[doc.id]);
    if(count.rows[0].total>=4)throw new CloudError(409,'Encrypted epoch archive limit; preserve/export history before another cut');
    const bytes=size(descriptor)+size(proof)+size(checkpoint)+size(doc.binding)+(root?size(root.intent.proof):0)+members.reduce((sum,item)=>sum+item.metadata_bytes+(item.certificate?size(item.certificate):0),0);
    await charge(client,doc,bytes);
    await client.query(`INSERT INTO needware_document_epoch(document_id,generation,status,binding,previous_binding,descriptor,root_epoch,authority,transition,checkpoint_manifest,source_cursor,owner_account,owner_device,members,storage_bytes,recipient_certificates,root_rotation_id,root_rotation_proof)
      VALUES($1,$2,'staging',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[doc.id,next.generation,next,doc.binding,descriptor,rootEpoch,authority,proof,checkpoint,payload.source_cursor,identity.account,identity.device,JSON.stringify(members),bytes,JSON.stringify(members.slice(1).map(item=>item.certificate)),root?.intent.id??null,root?.intent.proof??null]);
    return {generation:next.generation,status:'staging'};
  }
  if(action==='epoch_download'){
    object(payload,['action','document','index']);if(!doc.ready||!identity.grant)throw new CloudError(403,'Current document grant required');
    const row=await epoch(client,doc,doc.binding.generation);
    if(row.status!=='active'||!row.checkpoint_manifest||!Number.isInteger(payload.index)||Number(payload.index)<0||Number(payload.index)>=Math.ceil(row.checkpoint_manifest.bytes/1048576))throw new CloudError(400,'Invalid checkpoint chunk');
    const chunk=await client.query('SELECT ciphertext FROM needware_document_epoch_chunk WHERE document_id=$1 AND generation=$2 AND kind=\'checkpoint\' AND chunk_index=$3',[doc.id,row.generation,payload.index]);
    if(!chunk.rowCount)throw new CloudError(404,'Encrypted checkpoint unavailable');return {index:payload.index,ciphertext:chunk.rows[0].ciphertext.toString('base64')};
  }
  if(!identity.owner)throw new CloudError(403,'Pinned document owner required');
  if(action==='epoch_archive'){
    object(payload,['action','document','generation','cursor']);const row=await epoch(client,doc,positive(payload.generation));
    if(row.status!=='archived')throw new CloudError(409,'Epoch is not archived');
    if(typeof payload.cursor!=='string'||!/^(0|[1-9][0-9]{0,5})$/.test(payload.cursor)||Number(payload.cursor)>Number(row.source_cursor))throw new CloudError(400,'Invalid archived history cursor');
    const frames=await client.query('SELECT frame,sequence FROM needware_document_epoch_frame WHERE document_id=$1 AND generation=$2 AND sequence>$3 ORDER BY sequence LIMIT 8',[doc.id,row.generation,payload.cursor]);
    const batch:string[]=[];let cursor=payload.cursor,total=0;for(const item of frames.rows){const length=Buffer.byteLength(item.frame);if(total+length>2500000)break;batch.push(item.frame);total+=length;cursor=String(item.sequence);}
    const authors=await client.query('SELECT certificate,membership,key_envelope FROM needware_document_retained_author WHERE document_id=$1 AND generation=$2 ORDER BY account_id,device_id',[doc.id,row.generation]);
    const ownerKey=await client.query('SELECT held FROM needware_document_history_key WHERE document_id=$1 AND generation=$2',[doc.id,row.generation]);
    const roots=await client.query("SELECT proof FROM needware_root_rotation WHERE account_id=$1 AND status='active' ORDER BY (proof->'transition'->'next'->>'epoch')::bigint DESC LIMIT 4",[doc.owner_id]);
    const legacyOwner=row.members.find(member=>member.account_id===doc.owner_id&&(member.key_envelope as {kind?:string})?.kind==='held');
    return {descriptor:row.descriptor,epoch:{previous_binding:row.previous_binding,transition:row.transition,checkpoint_manifest:row.checkpoint_manifest,root_rotation:row.root_rotation_proof},members:row.members,recipient_certificates:row.recipient_certificates,retained_authors:authors.rows,owner_key:ownerKey.rows[0]?.held??(legacyOwner?.key_envelope as {value?:unknown})?.value??null,root_chain:roots.rows.map(row=>row.proof),frames:batch,cursor,more:Number(cursor)<Number(row.source_cursor)};
  }
  if(action==='epoch_archive_download'){
    object(payload,['action','document','generation','kind','index']);const row=await epoch(client,doc,positive(payload.generation));
    const expected=payload.kind==='package'?Number(row.descriptor.package_bytes):payload.kind==='checkpoint'?row.checkpoint_manifest?.bytes:undefined;
    if(row.status!=='archived'||!expected||!Number.isInteger(payload.index)||Number(payload.index)<0||Number(payload.index)>=Math.ceil(expected/1048576))throw new CloudError(400,'Invalid archived encrypted chunk');
    const chunks=await client.query('SELECT ciphertext FROM needware_document_epoch_chunk WHERE document_id=$1 AND generation=$2 AND kind=$3 AND chunk_index=$4',[doc.id,row.generation,payload.kind,payload.index]);
    if(!chunks.rowCount)throw new CloudError(404,'Archived encrypted chunk unavailable');return {index:payload.index,ciphertext:chunks.rows[0].ciphertext.toString('base64')};
  }
  const generation=positive(payload.generation),row=await epoch(client,doc,generation);
  if(root&&row.root_rotation_id!==root.intent.id)throw new CloudError(409,'Document cut belongs to another account root intent');
  if(action==='epoch_status'){
    object(payload,['action','document','generation',...rootFields]);const chunks=await client.query('SELECT kind,chunk_index FROM needware_document_epoch_chunk WHERE document_id=$1 AND generation=$2 ORDER BY kind,chunk_index',[doc.id,generation]);
    return {generation,status:row.status,binding:row.binding,chunks:chunks.rows};
  }
  if(action==='epoch_cancel'){
    if(row.root_rotation_id)throw new CloudError(409,'Cancel the complete account root intent');
    object(payload,['action','document','generation']);if(row.status!=='staging')throw new CloudError(409,'Only a staged epoch can be cancelled');
    await charge(client,doc,-Number(row.storage_bytes));await client.query('DELETE FROM needware_document_epoch WHERE document_id=$1 AND generation=$2',[doc.id,generation]);return {cancelled:true};
  }
  if(row.owner_account!==identity.account||row.owner_device!==identity.device)throw new CloudError(403,'The staging device must complete this epoch');
  if(action==='epoch_activate'&&row.root_rotation_id&&!root?.activate)throw new CloudError(409,'Publish all account document cuts through the root transaction');
  if(action==='epoch_activate'&&row.status==='active'){
    object(payload,['action','document','generation']);if(!same(row.binding,doc.binding))throw new CloudError(409,'Epoch activation was superseded');return {generation,status:'active'};
  }
  writer(identity);if(row.status!=='staging'||!same(row.previous_binding,doc.binding)||Number(row.root_epoch)!==rootEpoch||!row.authority.equals(authority)||(!root&&row.root_rotation_id))throw new CloudError(409,'Epoch source binding or owner root changed');
  if(action==='epoch_chunk'){
    object(payload,['action','document','generation','kind','index','ciphertext',...rootFields]);const expected=payload.kind==='package'?Number(row.descriptor.package_bytes):payload.kind==='checkpoint'?row.checkpoint_manifest?.bytes:undefined;
    if(!expected||!Number.isInteger(payload.index)||Number(payload.index)<0||Number(payload.index)>=Math.ceil(expected/1048576))throw new CloudError(400,'Invalid staged encrypted chunk');
    const index=Number(payload.index),length=Math.min(1048576,expected-index*1048576),content=ciphertext(payload.ciphertext,length,length);
    const prior=await client.query('SELECT ciphertext FROM needware_document_epoch_chunk WHERE document_id=$1 AND generation=$2 AND kind=$3 AND chunk_index=$4',[doc.id,generation,payload.kind,index]);
    if(prior.rowCount){if(!prior.rows[0].ciphertext.equals(content))throw new CloudError(409,'Immutable staged chunk differs');}
    else{await charge(client,doc,content.length);await client.query('INSERT INTO needware_document_epoch_chunk(document_id,generation,kind,chunk_index,ciphertext) VALUES($1,$2,$3,$4,$5)',[doc.id,generation,payload.kind,index,content]);await client.query('UPDATE needware_document_epoch SET storage_bytes=storage_bytes+$3 WHERE document_id=$1 AND generation=$2',[doc.id,generation,content.length]);}
    return {index,digest:createHash('sha256').update(content).digest('hex')};
  }
  if(action!=='epoch_activate')throw new CloudError(400,'Unknown document epoch operation');object(payload,['action','document','generation',...rootFields]);
  if(Number(row.source_cursor)!==Number(doc.next_sequence))throw new CloudError(409,'Source history changed; cancel, pull and review another cut');
  // Recheck selected recipients at activation; a revoked or rotated device cannot receive this cut.
  for(const member of row.members.slice(1)){
    const registered=await client.query('SELECT d.certificate,v.context,v.authority FROM needware_vault_device d JOIN needware_account_vault v ON v.account_id=d.account_id WHERE d.account_id=$1 AND d.device_id=$2 FOR SHARE OF d,v',[member.account_id,member.device_id]);
    if(!member.certificate||!registered.rowCount||!same(registered.rows[0].certificate,member.certificate)||!same(registered.rows[0].context,member.certificate.context)||!registered.rows[0].authority.equals(Buffer.from(member.certificate.authority)))throw new CloudError(409,'Retained recipient changed; cancel and review another cut');
  }
  await verifyChunks(client,doc,row,'package',{digest:String(row.descriptor.package_digest),bytes:Number(row.descriptor.package_bytes)});
  if(!row.checkpoint_manifest)throw new CloudError(409,'Epoch checkpoint missing');await verifyChunks(client,doc,row,'checkpoint',row.checkpoint_manifest);
  const retained=await client.query('SELECT COALESCE(sum(storage_bytes),0)::text AS bytes FROM needware_document_epoch WHERE document_id=$1 AND status IN (\'staging\',\'archived\')',[doc.id]);
  const activeBytes=Number(doc.storage_bytes)-Number(retained.rows[0].bytes);
  const oldMembers=await client.query<Member>('SELECT account_id,device_id,membership,key_envelope,metadata_bytes FROM needware_document_member WHERE document_id=$1 ORDER BY account_id,device_id',[doc.id]);
  const archived=await client.query(`UPDATE needware_document_epoch SET status='archived',source_cursor=$3,members=$4,storage_bytes=$5 WHERE document_id=$1 AND generation=$2 AND status='active' RETURNING generation`,[doc.id,doc.binding.generation,doc.next_sequence,JSON.stringify(oldMembers.rows),activeBytes]);
  if(!archived.rowCount){await client.query(`INSERT INTO needware_document_epoch(document_id,generation,status,binding,descriptor,root_epoch,authority,source_cursor,owner_account,owner_device,members,storage_bytes)
    VALUES($1,$2,'archived',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[doc.id,doc.binding.generation,doc.binding,doc.descriptor,doc.root_epoch,doc.authority,doc.next_sequence,identity.account,identity.device,JSON.stringify(oldMembers.rows),activeBytes]);}
  await client.query(`INSERT INTO needware_document_epoch_chunk(document_id,generation,kind,chunk_index,ciphertext) SELECT document_id,$2,'package',chunk_index,ciphertext FROM needware_document_chunk WHERE document_id=$1`,[doc.id,doc.binding.generation]);
  await client.query('INSERT INTO needware_document_epoch_frame(document_id,generation,digest,sequence,frame) SELECT document_id,$2,digest,sequence,frame FROM needware_document_frame WHERE document_id=$1',[doc.id,doc.binding.generation]);
  // The deletion trigger refunds current member metadata. Archives still retain
  // those opaque envelopes and signatures, so restore exactly that charge.
  await client.query('DELETE FROM needware_document_member WHERE document_id=$1',[doc.id]);await charge(client,doc,oldMembers.rows.reduce((total,item)=>total+item.metadata_bytes,0));
  for(const member of row.members)await client.query('INSERT INTO needware_document_member(document_id,account_id,device_id,membership,key_envelope,metadata_bytes) VALUES($1,$2,$3,$4,$5,$6)',[doc.id,member.account_id,member.device_id,member.membership,member.key_envelope,member.metadata_bytes]);
  await client.query('DELETE FROM needware_document_frame WHERE document_id=$1',[doc.id]);await client.query('DELETE FROM needware_document_chunk WHERE document_id=$1',[doc.id]);
  await client.query('UPDATE needware_document_epoch SET status=\'active\' WHERE document_id=$1 AND generation=$2',[doc.id,generation]);
  await client.query('UPDATE needware_document SET binding=$2,descriptor=$3,package_digest=$4,package_bytes=$5,next_sequence=0,root_epoch=$6,authority=$7 WHERE id=$1',[doc.id,row.binding,row.descriptor,row.descriptor.package_digest,row.descriptor.package_bytes,row.root_epoch,row.authority]);
  await client.query('DELETE FROM needware_document_rekey WHERE document_id=$1',[doc.id]);
  return {generation,status:'active'};
}
