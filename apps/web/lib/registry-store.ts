import 'server-only';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import canonicalize from 'canonicalize';
import {CloudError} from './cloud-request';
import {object,uuid} from './vault-proof';
import {verifyRegistryPackage} from './package-verify';
import type {PackageInfo} from '../../../packages/browser-host/src/protocol';
import {ownerLock} from './generation-store';
import {creationHeld} from './creation-hold';
export type RegistryEntry={id:string;owner_id:string;application_id:string;visibility:'private'|'unlisted'|'public';title:string;summary:string;current_digest:string;version:string;moderated:boolean;moderation_reason?:string|null;source_entry?:string|null;source_digest?:string|null;document_id?:string|null;package_info?:PackageInfo|null};
const digest=(value:unknown):string=>{if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw new CloudError(400,'Invalid revision digest');return value;};
export async function registryEntry(pool:Pool,id:string,viewer?:string,revision?:string):Promise<RegistryEntry>{
  uuid(id);if(revision)digest(revision);
  const result=await pool.query<RegistryEntry>(`SELECT e.*,r.source_entry,r.source_digest,r.document_id,r.package_info FROM needware_registry_entry e
    JOIN needware_registry_revision r ON r.entry_id=e.id AND r.digest=COALESCE($3,e.current_digest)
    WHERE e.id=$1 AND ((e.visibility<>'private' AND NOT e.moderated AND NOT EXISTS(SELECT 1 FROM needware_account_hold h WHERE h.account_id=e.owner_id AND h.active)) OR e.owner_id=$2)`,[id,viewer??null,revision??null]);
  if(!result.rowCount)throw new CloudError(404,'Application unavailable');return result.rows[0];
}
export async function registryList(pool:Pool,viewer?:string):Promise<RegistryEntry[]>{
  const result=await pool.query<RegistryEntry>(`SELECT e.*,r.document_id,r.source_entry,r.source_digest FROM needware_registry_entry e JOIN needware_registry_revision r ON r.entry_id=e.id AND r.digest=e.current_digest
    WHERE (visibility='public' AND NOT moderated AND NOT EXISTS(SELECT 1 FROM needware_account_hold h WHERE h.account_id=e.owner_id AND h.active)) OR owner_id=$1 ORDER BY updated_at DESC,id LIMIT 256`,[viewer??null]);return result.rows;
}
async function lockOwner(client:PoolClient,owner:string){await ownerLock(client,owner);await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1742))',[owner]);}
export async function publishRegistry(pool:Pool,owner:string,payload:unknown):Promise<RegistryEntry>{
  const value=object(payload,['action','id','expected_version','visibility','title','summary','package','document','source']);
  if(value.action!=='publish'||!['private','unlisted','public'].includes(String(value.visibility))||typeof value.title!=='string'||!value.title.trim()||value.title.length>120||typeof value.summary!=='string'||value.summary.length>1000||!Number.isSafeInteger(value.expected_version)||Number(value.expected_version)<0)throw new CloudError(400,'Invalid application publication');
  const id=value.id===null?randomUUID():uuid(value.id),visibility=value.visibility as RegistryEntry['visibility'];
  let bytes:Buffer|null=null,info:PackageInfo|null=null,document:string|null=null;
  if(visibility==='private'){
    if(value.package!==null||value.source!==null)throw new CloudError(400,'Private entries use encrypted documents');document=uuid(value.document);
  }else{
    if(value.document!==null||typeof value.package!=='string'||value.package.length>5592408||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.package))throw new CloudError(400,'Invalid signed publication package');
    bytes=Buffer.from(value.package,'base64');if(bytes.toString('base64')!==value.package)throw new CloudError(400,'Noncanonical package encoding');info=await verifyRegistryPackage(bytes);
  }
  const source=value.source===null?null:object(value.source,['entry','digest']);if(source){uuid(source.entry);digest(source.digest);if(source.entry===id)throw new CloudError(400,'An application cannot remix itself');}
  const client=await pool.connect();
  try{await client.query('BEGIN');await lockOwner(client,owner);if(await creationHeld(client,owner))throw new CloudError(403,'Publication is paused after operator review; your data and deletion remain available');
    const prior=await client.query<RegistryEntry&{cleartext:boolean;revision:string;metadata_bytes:number}>(`SELECT e.*,r.revision,(r.package IS NOT NULL) AS cleartext,r.source_entry,r.source_digest FROM needware_registry_entry e
      JOIN needware_registry_revision r ON r.entry_id=e.id AND r.digest=e.current_digest WHERE e.id=$1 FOR UPDATE OF e`,[id]);
    if(prior.rowCount&&prior.rows[0].owner_id!==owner)throw new CloudError(404,'Application unavailable');
    if(Number(prior.rows[0]?.version??0)!==value.expected_version)throw new CloudError(409,'Application changed; reload before publishing');
    let application:string,revision:string,key:string;
    if(document){const doc=await client.query('SELECT binding,descriptor FROM needware_document WHERE id=$1 AND owner_id=$2 AND ready FOR SHARE',[document,owner]);
      if(!doc.rowCount)throw new CloudError(404,'Owned encrypted document unavailable');application=doc.rows[0].binding.application;revision=doc.rows[0].binding.revision;key=doc.rows[0].descriptor.package_digest;
    }else{application=info!.application.id;revision=info!.application.revision;key=info!.digest;}
    if(prior.rowCount&&prior.rows[0].application_id!==application)throw new CloudError(409,'Stable entry must retain its application identity');
    if(prior.rowCount&&document&&prior.rows[0].cleartext&&revision!==prior.rows[0].revision)throw new CloudError(409,'Encrypted definition must match the published revision before changing visibility');
    if(prior.rowCount&&info&&key!==prior.rows[0].current_digest){
      if(prior.rows[0].cleartext&&(info.application.parent!==prior.rows[0].current_digest||info.application.revision===prior.rows[0].revision))throw new CloudError(409,'Successor must name the exact signed parent and a new revision');
      if(!prior.rows[0].cleartext&&info.application.revision!==prior.rows[0].revision)throw new CloudError(409,'Review the encrypted revision before publishing its definition');
    }
    if(source){const parent=await client.query(`SELECT e.application_id,r.package_info FROM needware_registry_entry e JOIN needware_registry_revision r ON r.entry_id=e.id WHERE e.id=$1 AND r.digest=$2 AND e.visibility<>'private' AND NOT e.moderated AND NOT EXISTS(SELECT 1 FROM needware_account_hold h WHERE h.account_id=e.owner_id AND h.active) FOR SHARE OF e,r`,[source.entry,source.digest]);
      const inherited=prior.rowCount&&prior.rows[0].source_entry===source.entry&&prior.rows[0].source_digest===source.digest&&info?.application.parent===prior.rows[0].current_digest;
      if(!parent.rowCount)throw new CloudError(404,'Remix source unavailable');if(parent.rows[0].application_id===application||!inherited&&info?.application.parent!==source.digest)throw new CloudError(400,'Remix must have its own identity and signed source digest');
    }
    const quota=await client.query(`SELECT count(*)::integer AS entries,COALESCE(sum(metadata_bytes),0)::text AS metadata,
      (SELECT COALESCE(sum(r.storage_bytes),0)::text FROM needware_registry_revision r JOIN needware_registry_entry e ON e.id=r.entry_id WHERE e.owner_id=$1) AS bytes
      FROM needware_registry_entry WHERE owner_id=$1`,[owner]);
    const existing=await client.query('SELECT package,document_id,source_entry,source_digest FROM needware_registry_revision WHERE entry_id=$1 AND digest=$2',[id,key]);
    const metadataBytes=Buffer.byteLength(value.title.trim())+Buffer.byteLength(value.summary)+128,infoJson=info?canonicalize(info)!:null,revisionBytes=(bytes?.length??0)+(infoJson?Buffer.byteLength(infoJson):0)+256;
    if(!prior.rowCount&&quota.rows[0].entries>=256||Number(quota.rows[0].bytes)+Number(quota.rows[0].metadata)+metadataBytes-(prior.rows[0]?.metadata_bytes??0)+(existing.rowCount?0:revisionBytes)>134217728)throw new CloudError(409,'Registry storage quota reached');
    if(existing.rowCount){const old=existing.rows[0];if((bytes?!old.package||!bytes.equals(old.package):old.package!==null)||old.document_id!==document||old.source_entry!==(source?.entry??null)||old.source_digest!==(source?.digest??null))throw new CloudError(409,'Published revisions are immutable');}
    else if((await client.query('SELECT count(*)::integer AS count FROM needware_registry_revision WHERE entry_id=$1',[id])).rows[0].count>=32)throw new CloudError(409,'Revision retention quota reached');
    await client.query(`INSERT INTO needware_registry_entry(id,owner_id,application_id,visibility,title,summary,current_digest,metadata_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(id) DO UPDATE SET visibility=EXCLUDED.visibility,title=EXCLUDED.title,summary=EXCLUDED.summary,current_digest=EXCLUDED.current_digest,metadata_bytes=EXCLUDED.metadata_bytes,version=needware_registry_entry.version+1,updated_at=now()`,[id,owner,application,visibility,value.title.trim(),value.summary,key,metadataBytes]);
    if(!existing.rowCount)await client.query(`INSERT INTO needware_registry_revision(entry_id,digest,revision,package,package_info,document_id,source_entry,source_digest,storage_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,key,revision,bytes,infoJson,document,source?.entry??null,source?.digest??null,revisionBytes]);
    await client.query('COMMIT');return await registryEntry(pool,id,owner);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();bytes?.fill(0);}
}
export async function removeRegistry(pool:Pool,owner:string,id:string,version:number){uuid(id);if(!Number.isSafeInteger(version)||version<1)throw new CloudError(400,'Invalid application version');
  const client=await pool.connect();try{await client.query('BEGIN');await lockOwner(client,owner);
    const result=await client.query('DELETE FROM needware_registry_entry WHERE id=$1 AND owner_id=$2 AND version=$3 RETURNING id',[id,owner,version]);
    if(!result.rowCount)throw new CloudError(409,'Application unavailable or changed');await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
