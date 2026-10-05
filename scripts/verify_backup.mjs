import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,symlink,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {backupConfig,backupDatabase,restoreDatabase} from './backup-lib.mjs';
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{Pool}=require('pg');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyBackup({page,pool,account}){
  const source=new URL(process.env.DATABASE_URL);assert(['127.0.0.1','localhost','[::1]'].includes(source.hostname));assert(/^\/needware_acceptance_[a-f0-9]{32}$/.test(source.pathname));assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,source.pathname.slice(1));
  await page.evaluate(async()=>{const r=globalThis.__needwareRelay,{DurableSyncSession}=await import('/sync-journal.js'),bytes=r.wasm.authored_sync_example(),scope=JSON.stringify({values:[],collections:['habits']}),native=r.vault.start_document(bytes,crypto.randomUUID(),scope,1,true),root=await r.store.load(JSON.parse(r.vault.account_context()).account);root.bytes.fill(0);const journal=await DurableSyncSession.create(r.store.documents,r.vault,bytes,native,{account:JSON.parse(r.vault.account_context()).account,rootGeneration:root.generation,scope,ownerEpoch:1,authority:r.vault.account_authority(),roster:JSON.stringify([JSON.parse(native.membership())])});await r.relay.synchronize(journal);await r.relay.synchronize(journal);await journal.close();});
  const tables=['auth_user','auth_account','needware_account_vault','needware_vault_device','needware_document','needware_document_chunk','needware_document_member'];
  const fingerprint=async db=>{const result={};for(const table of tables){const rows=await db.query(`SELECT * FROM ${table}`);result[table]=hash(Buffer.from(JSON.stringify(rows.rows.map(row=>JSON.stringify(row)).sort())));}return result;};
  const prior=await fingerprint(pool),directory=await mkdtemp(join(tmpdir(),'needware-backup-test-')),key=randomBytes(32),config=backupConfig({...process.env,NEEDWARE_BACKUP_KEY:key.toString('hex')}),name=`needware_restore_${randomBytes(16).toString('hex')}`,targetURL=new URL(source);targetURL.pathname=`/${name}`;
  const targetConfig=backupConfig({...process.env,DATABASE_URL:targetURL.toString(),NEEDWARE_BACKUP_KEY:key.toString('hex')}),target=new Pool({connectionString:targetURL.toString()}),artifact=join(directory,'backup.needbk');let created=false;
  try{await pool.query(`CREATE DATABASE "${name}"`);created=true;
    await backupDatabase(artifact,config,{container:true});const encrypted=await readFile(artifact);assert(encrypted.subarray(0,8).equals(Buffer.from('NEEDBK01')));assert.equal((await stat(artifact)).mode&0o777,0o400);assert(!encrypted.includes(Buffer.from(account)));
    await assert.rejects(backupDatabase(artifact,config,{container:true}));assert.equal(hash(await readFile(artifact)),hash(encrypted));const second=join(directory,'second.needbk');await backupDatabase(second,config,{container:true});assert(!encrypted.subarray(8,20).equals((await readFile(second)).subarray(8,20)));
    const empty=async()=>assert.equal(Number((await target.query("SELECT count(*) AS count FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='public'")).rows[0].count),0);
    const wrong={...targetConfig,key:randomBytes(32)};try{await assert.rejects(restoreDatabase(artifact,wrong,{container:true}),/authentication failed/);await empty();}finally{wrong.key.fill(0);}
    for(const position of [0,8,20,encrypted.length-1]){const corrupt=Buffer.from(encrypted);corrupt[position]^=1;const path=join(directory,`tamper-${position}`);await writeFile(path,corrupt,{mode:0o600});await assert.rejects(restoreDatabase(path,targetConfig,{container:true}),/authentication failed/);await empty();}
    const short=join(directory,'truncated');await writeFile(short,encrypted.subarray(0,encrypted.length-7),{mode:0o600});await assert.rejects(restoreDatabase(short,targetConfig,{container:true}),/authentication failed/);await empty();
    const linked=join(directory,'symlink');await symlink(artifact,linked);await assert.rejects(restoreDatabase(linked,targetConfig,{container:true}));await empty();
    await pool.query(`ALTER DATABASE "${name}" SET default_transaction_read_only=on`);await target.end();await assert.rejects(restoreDatabase(artifact,targetConfig,{container:true}),/restore failed/);await pool.query(`ALTER DATABASE "${name}" RESET default_transaction_read_only`);
    const restored=new Pool({connectionString:targetURL.toString()});try{await restoreDatabase(artifact,targetConfig,{container:true});assert.deepEqual(await fingerprint(restored),prior);assert.equal((await restored.query('SELECT id FROM auth_user WHERE id=$1',[account])).rowCount,1);
      await assert.rejects(restoreDatabase(artifact,targetConfig,{container:true}),/separate empty/);assert.deepEqual(await fingerprint(restored),prior);
    }finally{await restored.end();}
    assert.deepEqual(await fingerprint(pool),prior);assert.throws(()=>backupConfig({...process.env,NEEDWARE_BACKUP_KEY:'bad'}),/32-byte/);assert.throws(()=>backupConfig({...process.env,NEEDWARE_BACKUP_KEY:key.toString('hex'),DATABASE_URL:'postgresql://user:password@remote.invalid/needware?sslmode=disable'}),/certificate-verified/);
    console.log('PASS encrypted backup/restore: real PostgreSQL dump and atomic empty-target restore, roots/devices/encrypted chunks/accounts exact, wrong key/tamper/truncation/symlink denial before writes, read-only restore rollback, immutable publication and preserved source');
  }finally{await target.end().catch(()=>{});config.key.fill(0);targetConfig.key.fill(0);key.fill(0);if(created)await pool.query(`DROP DATABASE "${name}"`);await rm(directory,{recursive:true,force:true});}
}
