import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {loadEnvironment} from './load-environment.mjs';
import {schemaReady,migrationFiles,verifyMigrationFiles,assertPriorSchema} from './schema-readiness.mjs';
loadEnvironment();
const source=new URL(process.env.DATABASE_URL);
assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname),'Disposable local database required');
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{Pool}=require('pg');
const database='needware_acceptance_'+randomBytes(16).toString('hex'),url=new URL(source);url.pathname='/'+database;
const admin=new Pool({connectionString:source.href});let pool,created=false;
const migrationFilesCache=await migrationFiles();
try{
  await admin.query(`CREATE DATABASE "${database}"`);created=true;
  pool=new Pool({connectionString:url.href});
  for(let i=0;i<2;i++)assert.equal(spawnSync(process.execPath,['scripts/auth-migrate.mjs'],{stdio:'inherit',env:{...process.env,DATABASE_URL:url.href,NEEDWARE_ACCEPTANCE_DATABASE:database}}).status,0);
  assert.equal(await schemaReady(pool),true);
  await pool.query('ALTER TABLE needware_email_outbox ADD COLUMN injected_drift text');
  assert.equal(await schemaReady(pool),false);
  await assert.rejects(()=>assertPriorSchema(pool),/DATABASE_SCHEMA_DRIFT/);
  await pool.query('ALTER TABLE needware_email_outbox DROP COLUMN injected_drift');
  assert.equal(await schemaReady(pool),true);
  await assertPriorSchema(pool);
  await pool.query("UPDATE needware_schema_migration SET sha256=repeat('0',64) WHERE name='0001-email-outbox.sql'");
  await assert.rejects(()=>verifyMigrationFiles(pool,migrationFilesCache),/MIGRATION_CHECKSUM_CHANGED/);
  const client=await pool.connect();try{await client.query('BEGIN READ ONLY');await assert.rejects(()=>client.query("UPDATE needware_schema_migration SET sha256=repeat('1',64)"),/read-only transaction/);}finally{await client.query('ROLLBACK');client.release();}
  console.log('PASS migration idempotence, exact checksums, catalog drift and enforced read-only probes');
}finally{if(pool)await pool.end();try{if(created)await admin.query(`DROP DATABASE "${database}"`);}finally{await admin.end();}}
