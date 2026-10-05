import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import { CloudError } from './cloud-request';
import { bytes, context, object, publicKey, type Certificate } from './vault-proof';
import type { Membership } from './document-proof';
export const encodedSize=(value:unknown)=>Buffer.byteLength(canonicalize(value)!);
export function envelope(value:unknown,grant:Membership,recipient:Certificate):void{
  const fields=object(value,['kind','value']);
  if(fields.kind==='held'){
    const held=object(fields.value,['document','holder','authority','ciphertext']);context(held.holder,recipient.context.account);publicKey(held.authority);bytes(held.ciphertext,72);
    if(canonicalize(held.document)!==canonicalize(grant.document)||canonicalize(held.holder)!==canonicalize(recipient.context)||canonicalize(held.authority)!==canonicalize(recipient.authority))throw new CloudError(403,'Held key does not match its recipient');
  }else if(fields.kind==='offer'){
    const offer=object(fields.value,['membership','envelope']);if(canonicalize(offer.membership)!==canonicalize(grant)||encodedSize(offer.envelope)>16*1024)throw new CloudError(400,'Invalid document-key offer');
  }else throw new CloudError(400,'Invalid document-key envelope');
}
export async function charge(client:PoolClient,doc:{id:string;owner_id:string},amount:number,count=0):Promise<void>{
  const updated=await client.query(`UPDATE needware_relay_usage SET bytes=bytes+$2,documents=documents+$3 WHERE account_id=$1
    AND bytes+$2 BETWEEN 0 AND 134217728 AND documents+$3 BETWEEN 0 AND 256 RETURNING account_id`,[doc.owner_id,amount,count]);
  if(!updated.rowCount)throw new CloudError(409,'Cloud encrypted storage quota exceeded');
  await client.query('UPDATE needware_document SET storage_bytes=storage_bytes+$2 WHERE id=$1',[doc.id,amount]);
}
