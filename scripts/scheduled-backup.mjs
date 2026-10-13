// Unattended encrypted backup with an authenticated restore into a disposable local database.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {backupConfig,backupDatabase,restoreDatabase} from './backup-lib.mjs';
import {schemaDigest,assertPriorSchema} from './schema-readiness.mjs';
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{Pool}=require('pg');
const remote=backupConfig({...process.env,DATABASE_URL:process.env.NEEDWARE_BACKUP_DATABASE_URL,NEEDWARE_DATABASE_CA_PEM:process.env.NEEDWARE_BACKUP_CA_PEM,NEEDWARE_BACKUP_KEY:process.env.NEEDWARE_SCHEDULED_BACKUP_KEY});
const restoreUrl=new URL(process.env.NEEDWARE_BACKUP_RESTORE_URL);
assert.ok(!remote.local,'Production backup must use verified remote TLS');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(restoreUrl.hostname),'Restore target must be disposable and local');
const source=new Pool({connectionString:remote.url.href,ssl:{rejectUnauthorized:true,ca:remote.ca},max:1,connectionTimeoutMillis:10000});
const admin=new Pool({connectionString:restoreUrl.href,max:1});let target,local,sourceClient,created=false;
const database='needware_backup_restore_'+randomBytes(12).toString('hex'),directory=process.env.NEEDWARE_BACKUP_OUTPUT_DIRECTORY??'.local/scheduled-backup';
assert.match(directory,/^\.local\/scheduled-backup(?:-[a-z0-9-]+)?$/);const artifact=directory+'/needware.needbk';
try{
 sourceClient=await source.connect();await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await sourceClient.query("SET LOCAL timezone='UTC'");
 await assertPriorSchema(sourceClient);const before=await schemaDigest(sourceClient);await mkdir(directory,{recursive:true,mode:0o700});
 const snapshot=(await sourceClient.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
 const backup=await backupDatabase(artifact,remote,{scope:'public',snapshot});
 assert.ok(backup.bytes<=16*1024*1024,'Backup exceeds reviewed free artifact storage bound');
 await admin.query(`CREATE DATABASE "${database}"`);created=true;restoreUrl.pathname='/'+database;
 local=backupConfig({DATABASE_URL:restoreUrl.href,NEEDWARE_BACKUP_KEY:process.env.NEEDWARE_SCHEDULED_BACKUP_KEY,PATH:process.env.PATH});
 await restoreDatabase(artifact,local,{scope:'public'});target=new Pool({connectionString:restoreUrl.href,max:1});
 await assertPriorSchema(target);assert.equal(await schemaDigest(target),before,'Restored catalog must match source');
 await target.query("SET timezone='UTC'");
 const names=(await sourceClient.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'auth\\_%' ESCAPE '\\' OR tablename LIKE 'needware\\_%' ESCAPE '\\') ORDER BY tablename")).rows.map(r=>r.tablename);
 const digest=async pool=>{const hash=createHash('sha256');for(const name of names){assert.match(name,/^(auth|needware)_[a-z0-9_]+$/);const rows=await pool.query(`SELECT row_to_json(t)::text AS row FROM "${name}" t ORDER BY row_to_json(t)::text`);hash.update(name+'\0');for(const row of rows.rows)hash.update(row.row+'\0');}return hash.digest('hex');};
 const restored=await digest(target),current=await digest(sourceClient);assert.equal(restored,current,'Restored rows must match the exact exported source snapshot');
 const receipt={status:'PASS',checkedAt:new Date().toISOString(),encrypted:true,authenticatedRestore:true,schemaMatched:true,restoredDataDigest:restored,sourceDataMatches:true,snapshotConsistent:true,bytes:backup.bytes};
 await writeFile(directory+'/receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
}catch(error){console.error('FAIL scheduled backup or isolated restore; no plaintext artifact published',{code:error.code??error.name,reason:String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[REDACTED]').slice(0,160)});process.exitCode=1;}
finally{remote.key.fill(0);local?.key.fill(0);if(sourceClient){await sourceClient.query('ROLLBACK');sourceClient.release();}await source.end();await target?.end();if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();}
