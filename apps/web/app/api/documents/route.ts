import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import { accountRequest, canonicalBody, cloudFailure, cloudResponse, CloudError } from '../../../lib/cloud-request';
import { object, operationProof, certificate, context, publicKey, bytes, uuid } from '../../../lib/vault-proof';
import { binding, ciphertext, membership, type Binding, type Membership } from '../../../lib/document-proof';
export const runtime = 'nodejs';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);
const encodedSize = (value: unknown) => Buffer.byteLength(canonicalize(value)!);
type DocumentRow = { id: string; owner_id: string; binding: Binding; authority: Buffer; root_epoch: number; descriptor: Record<string, unknown>; package_digest: string; package_bytes: number; ready: boolean; storage_bytes: string; next_sequence: string };
function envelope(value: unknown, grant: Membership, recipient: ReturnType<typeof certificate>): void {
  const fields = object(value,['kind','value']);
  if (fields.kind === 'held') {
    const held = object(fields.value,['document','holder','authority','ciphertext']);
    context(held.holder,recipient.context.account); publicKey(held.authority); bytes(held.ciphertext,72);
    if (!same(held.document,grant.document) || !same(held.holder,recipient.context) || !same(held.authority,recipient.authority)) throw new CloudError(403,'Held key does not match its recipient');
  } else if (fields.kind === 'offer') {
    const offer = object(fields.value,['membership','envelope']);
    if (!same(offer.membership,grant) || encodedSize(offer.envelope)>16*1024) throw new CloudError(400,'Invalid document-key offer');
  } else throw new CloudError(400,'Invalid document-key envelope');
}
async function charge(client: PoolClient, doc: DocumentRow, amount: number, count = 0): Promise<void> {
  const updated = await client.query(`UPDATE needware_relay_usage SET bytes=bytes+$2,documents=documents+$3 WHERE account_id=$1
    AND bytes+$2 BETWEEN 0 AND 134217728 AND documents+$3 BETWEEN 0 AND 256 RETURNING account_id`,[doc.owner_id,amount,count]);
  if (!updated.rowCount) throw new CloudError(409,'Cloud encrypted storage quota exceeded');
  await client.query('UPDATE needware_document SET storage_bytes=storage_bytes+$2 WHERE id=$1',[doc.id,amount]);
}
export async function GET(request: Request) {
  try {
    const {session,pool}=await accountRequest(request);
    const rows=await pool.query(`SELECT DISTINCT d.id,d.binding,d.ready FROM needware_document d LEFT JOIN needware_document_member m ON m.document_id=d.id
      WHERE d.owner_id=$1 OR (m.account_id=$1 AND NOT m.revoked) ORDER BY d.id LIMIT 257`,[session.user.id]);
    if(rows.rowCount!>256) throw new CloudError(409,'Document count limit'); return cloudResponse({documents:rows.rows});
  }catch(error){return cloudFailure(error);}
}
export async function POST(request: Request) {
  try {
    const {session,pool}=await accountRequest(request);
    const body=object(await canonicalBody(request,3*1024*1024),['proof','payload']);
    const proof=operationProof(body.proof,session.user.id,body.payload);
    if(proof.operation!=='relay_document')throw new CloudError(400,'Invalid document operation');
    const payload=body.payload as Record<string,unknown>;
    if(!payload || typeof payload.action!=='string')throw new CloudError(400,'Invalid document request');
    const document=uuid(payload.document);const device=proof.certificate.device.id;const account=session.user.id;
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      // Registered device identity and nonce are rechecked inside the actual write transaction.
      const registered=await client.query(`SELECT v.context,v.authority,d.certificate FROM needware_account_vault v
        JOIN needware_vault_device d ON d.account_id=v.account_id WHERE v.account_id=$1 AND d.device_id=$2 FOR SHARE OF v,d`,[account,device]);
      if(!registered.rowCount || !registered.rows[0].authority.equals(Buffer.from(proof.certificate.authority))
        || !same(registered.rows[0].context,proof.certificate.context) || !same(registered.rows[0].certificate,proof.certificate))throw new CloudError(403,'Registered encryption device required');
      const nonce=await client.query(`DELETE FROM needware_vault_challenge WHERE id=$1 AND account_id=$2 AND session_id=$3 AND operation='relay_document'
        AND expires_at>now() RETURNING id`,[proof.nonce,account,session.session.id]);
      if(!nonce.rowCount)throw new CloudError(403,'Document challenge expired or consumed');
      const rows=await client.query<DocumentRow>('SELECT * FROM needware_document WHERE id=$1 FOR UPDATE',[document]);
      let data: unknown;
      if(payload.action==='create'){
        object(payload,['action','document','descriptor','membership','key_envelope']);
        const descriptor=object(payload.descriptor,['binding','configuration','package_digest','package_bytes']);
        const bound=binding(descriptor.binding,document);
        if(bound.document.account!==account || bound.document.epoch!==1 || bound.generation!==1 || bound.schema_epoch!==1)throw new CloudError(403,'Initial document must belong to the pinned account');
        if(typeof descriptor.package_digest!=='string' || !/^[0-9a-f]{64}$/.test(descriptor.package_digest)
          || !Number.isInteger(descriptor.package_bytes) || Number(descriptor.package_bytes)<40 || Number(descriptor.package_bytes)>33554472)throw new CloudError(400,'Invalid encrypted package manifest');
        ciphertext(descriptor.configuration,40,32*1024);
        const grant=membership(payload.membership,bound,registered.rows[0].authority,Number(proof.certificate.context.epoch));
        if(grant.role!=='write' || !same(grant.device,proof.certificate.device))throw new CloudError(403,'Owner document grant required');
        envelope(payload.key_envelope,grant,proof.certificate);
        if(rows.rowCount){
          const existing=await client.query('SELECT membership,key_envelope FROM needware_document_member WHERE document_id=$1 AND account_id=$2 AND device_id=$3 AND NOT revoked',[document,account,device]);
          if(rows.rows[0].owner_id!==account || !same(rows.rows[0].descriptor,descriptor) || !existing.rowCount
            || !same(existing.rows[0].membership,grant) || !same(existing.rows[0].key_envelope,payload.key_envelope))throw new CloudError(409,'Immutable document already exists');
        }else{
          await client.query('INSERT INTO needware_relay_usage(account_id) VALUES($1) ON CONFLICT DO NOTHING',[account]);
          const size=encodedSize(descriptor)+encodedSize(grant)+encodedSize(payload.key_envelope);
          const usage=await client.query(`UPDATE needware_relay_usage SET bytes=bytes+$2,documents=documents+1 WHERE account_id=$1
            AND bytes+$2<=134217728 AND documents<256 RETURNING account_id`,[account,size]);
          if(!usage.rowCount)throw new CloudError(409,'Cloud encrypted storage quota exceeded');
          await client.query(`INSERT INTO needware_document(id,owner_id,binding,authority,root_epoch,descriptor,package_digest,package_bytes,storage_bytes)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[document,account,bound,registered.rows[0].authority,proof.certificate.context.epoch,descriptor,descriptor.package_digest,descriptor.package_bytes,size]);
          await client.query(`INSERT INTO needware_document_member(document_id,account_id,device_id,membership,key_envelope,metadata_bytes)
            VALUES($1,$2,$3,$4,$5,$6)`,[document,account,device,grant,payload.key_envelope,encodedSize(grant)+encodedSize(payload.key_envelope)]);
        }
        data={document};
      }else{
        if(!rows.rowCount)throw new CloudError(404,'Document unavailable'); const doc=rows.rows[0];
        const member=await client.query(`SELECT membership,key_envelope FROM needware_document_member
          WHERE document_id=$1 AND account_id=$2 AND device_id=$3 AND NOT revoked`,[document,account,device]);
        const owner=doc.owner_id===account && doc.authority.equals(Buffer.from(proof.certificate.authority)) && Number(doc.root_epoch)===proof.certificate.context.epoch;
        if(!member.rowCount && !(owner && ['grant','recover','delete'].includes(payload.action)))throw new CloudError(403,'This device has no current document grant');
        const grant=member.rowCount?membership(member.rows[0].membership,doc.binding,doc.authority,Number(doc.root_epoch)):undefined;
        if(grant && !same(grant.device,proof.certificate.device))throw new CloudError(403,'Document device mismatch');
        switch(payload.action){
          case 'recover':{
            object(payload,['action','document']);if(!owner)throw new CloudError(403,'Pinned document owner required');
            const held=await client.query(`SELECT key_envelope FROM needware_document_member WHERE document_id=$1 AND account_id=$2 AND key_envelope->>'kind'='held' LIMIT 1`,[document,account]);
            if(!held.rowCount)throw new CloudError(409,'Owner-wrapped document key unavailable');
            data={descriptor:doc.descriptor,key_envelope:held.rows[0].key_envelope,root_epoch:Number(doc.root_epoch)};break;
          }
          case 'chunk':{
            object(payload,['action','document','index','ciphertext']);if(!owner || !grant || grant.role!=='write')throw new CloudError(403,'Owner write grant required');
            const index=Number(payload.index);const count=Math.ceil(doc.package_bytes/1048576);
            if(!Number.isInteger(payload.index)||index<0||index>=count)throw new CloudError(400,'Invalid encrypted package chunk');
            const expected=index===count-1?doc.package_bytes-index*1048576:1048576;const content=ciphertext(payload.ciphertext,expected,expected);
            const existing=await client.query('SELECT ciphertext FROM needware_document_chunk WHERE document_id=$1 AND chunk_index=$2',[document,index]);
            if(existing.rowCount){if(!existing.rows[0].ciphertext.equals(content))throw new CloudError(409,'Immutable package chunk differs');}
            else{if(doc.ready)throw new CloudError(409,'Package already finalized');await charge(client,doc,content.length);
              await client.query('INSERT INTO needware_document_chunk(document_id,chunk_index,ciphertext) VALUES($1,$2,$3)',[document,index,content]);}
            data={index,digest:hash(content)};break;
          }
          case 'finalize':{
            object(payload,['action','document']);if(!owner || grant?.role!=='write')throw new CloudError(403,'Owner write grant required');
            const chunks=await client.query('SELECT chunk_index,ciphertext FROM needware_document_chunk WHERE document_id=$1 ORDER BY chunk_index',[document]);
            const count=Math.ceil(doc.package_bytes/1048576);const digest=createHash('sha256');let length=0;
            if(chunks.rowCount!==count)throw new CloudError(409,'Encrypted package upload incomplete');
            for(let index=0;index<count;index++){if(chunks.rows[index].chunk_index!==index)throw new CloudError(409,'Encrypted package chunk missing');digest.update(chunks.rows[index].ciphertext);length+=chunks.rows[index].ciphertext.length;}
            if(length!==doc.package_bytes||digest.digest('hex')!==doc.package_digest)throw new CloudError(409,'Encrypted package manifest mismatch');
            await client.query('UPDATE needware_document SET ready=true WHERE id=$1',[document]);data={ready:true};break;
          }
          case 'read':{
            object(payload,['action','document','cursor']);if(!doc.ready)throw new CloudError(409,'Encrypted package upload incomplete');
            if(typeof payload.cursor!=='string'||!/^(0|[1-9][0-9]{0,5})$/.test(payload.cursor)||Number(payload.cursor)>Number(doc.next_sequence))throw new CloudError(400,'Invalid relay cursor');
            const frames=await client.query('SELECT frame,sequence FROM needware_document_frame WHERE document_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 8',[document,payload.cursor]);
            const batch: string[]=[];let total=0;let cursor=payload.cursor;
            for(const row of frames.rows){const length=Buffer.byteLength(row.frame);if(total+length>2500000)break;batch.push(row.frame);total+=length;cursor=String(row.sequence);}
            const roster=await client.query('SELECT membership FROM needware_document_member WHERE document_id=$1 AND NOT revoked ORDER BY device_id',[document]);
            data={descriptor:doc.descriptor,membership:member.rows[0].membership,key_envelope:member.rows[0].key_envelope,roster:roster.rows.map(row=>row.membership),frames:batch,cursor,more:Number(cursor)<Number(doc.next_sequence)};break;
          }
          case 'download':{
            object(payload,['action','document','index']);if(!doc.ready)throw new CloudError(409,'Encrypted package upload incomplete');
            if(!Number.isInteger(payload.index)||Number(payload.index)<0||Number(payload.index)>=Math.ceil(doc.package_bytes/1048576))throw new CloudError(400,'Invalid encrypted package chunk');
            const chunk=await client.query('SELECT ciphertext FROM needware_document_chunk WHERE document_id=$1 AND chunk_index=$2',[document,payload.index]);
            if(!chunk.rowCount)throw new CloudError(404,'Encrypted package chunk unavailable');data={index:payload.index,ciphertext:chunk.rows[0].ciphertext.toString('base64')};break;
          }
          case 'upload':{
            object(payload,['action','document','frame']);if(!doc.ready||grant?.role!=='write')throw new CloudError(403,'Current write grant required');
            if(typeof payload.frame!=='string'||Buffer.byteLength(payload.frame)>2097152)throw new CloudError(413,'Encrypted frame size limit');
            let frame: Record<string,unknown>;try{frame=object(JSON.parse(payload.frame),['binding','ciphertext']);}catch{throw new CloudError(400,'Invalid encrypted frame');}
            if(canonicalize(frame)!==payload.frame||!same(frame.binding,doc.binding)||!Array.isArray(frame.ciphertext)||frame.ciphertext.length<40
              ||frame.ciphertext.length>524328||!frame.ciphertext.every(item=>Number.isInteger(item)&&Number(item)>=0&&Number(item)<=255))throw new CloudError(400,'Encrypted frame binding or ciphertext invalid');
            const digest=hash(payload.frame);const existing=await client.query('SELECT sequence FROM needware_document_frame WHERE document_id=$1 AND digest=$2',[document,digest]);
            if(existing.rowCount)data={digest,cursor:String(existing.rows[0].sequence)};
            else{if(Number(doc.next_sequence)>=100000)throw new CloudError(409,'Encrypted document history limit');await charge(client,doc,Buffer.byteLength(payload.frame));
              const sequence=Number(doc.next_sequence)+1;await client.query('INSERT INTO needware_document_frame(document_id,digest,sequence,frame) VALUES($1,$2,$3,$4)',[document,digest,sequence,payload.frame]);
              await client.query('UPDATE needware_document SET next_sequence=$2 WHERE id=$1',[document,sequence]);data={digest,cursor:String(sequence)};}break;
          }
          case 'grant':{
            object(payload,['action','document','recipient','membership','key_envelope']);if(!owner)throw new CloudError(403,'Pinned document owner required');
            const target=payload.recipient as Record<string,unknown>;const recipient=certificate(target,uuid((target?.context as Record<string,unknown>)?.account));
            const registeredRecipient=await client.query('SELECT certificate FROM needware_vault_device WHERE account_id=$1 AND device_id=$2 FOR SHARE',[recipient.context.account,recipient.device.id]);
            if(!registeredRecipient.rowCount||!same(registeredRecipient.rows[0].certificate,recipient))throw new CloudError(403,'Recipient device is not registered');
            const issued=membership(payload.membership,doc.binding,doc.authority,Number(doc.root_epoch));if(!same(issued.device,recipient.device))throw new CloudError(403,'Grant recipient mismatch');
            envelope(payload.key_envelope,issued,recipient);
            const before=await client.query('SELECT membership,key_envelope,revoked FROM needware_document_member WHERE document_id=$1 AND account_id=$2 AND device_id=$3',[document,recipient.context.account,recipient.device.id]);
            if(before.rowCount){if(before.rows[0].revoked||!same(before.rows[0].membership,issued)||!same(before.rows[0].key_envelope,payload.key_envelope))throw new CloudError(409,'Existing document grant preserved');}
            else{const count=await client.query('SELECT count(*)::integer AS total FROM needware_document_member WHERE document_id=$1',[document]);if(count.rows[0].total>=256)throw new CloudError(409,'Document member limit');
              const metadataBytes=encodedSize(issued)+encodedSize(payload.key_envelope);
              await charge(client,doc,metadataBytes);await client.query('INSERT INTO needware_document_member(document_id,account_id,device_id,membership,key_envelope,metadata_bytes) VALUES($1,$2,$3,$4,$5,$6)',[document,recipient.context.account,recipient.device.id,issued,payload.key_envelope,metadataBytes]);}
            data={device:recipient.device.id};break;
          }
          case 'delete':{
            object(payload,['action','document']);if(!owner)throw new CloudError(403,'Pinned document owner required');
            await client.query('UPDATE needware_relay_usage SET bytes=bytes-$2,documents=documents-1 WHERE account_id=$1',[doc.owner_id,Number(doc.storage_bytes)]);
            await client.query('DELETE FROM needware_document WHERE id=$1',[document]);data={deleted:true};break;
          }
          default:throw new CloudError(400,'Unknown document operation');
        }
      }
      await client.query('COMMIT');return cloudResponse(data);
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }catch(error){return cloudFailure(error);}
}
