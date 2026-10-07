// Disposable local database only; no external mail, model or production data.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {loadEnvironment} from './load-environment.mjs';
loadEnvironment();
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{Pool}=require('pg');
const source=new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(source.hostname),'Local database required');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(process.env.SMTP_HOST),'Local SMTP required');
const database=`needware_scheduled_${randomBytes(16).toString('hex')}`,admin=new Pool({connectionString:source.toString()});let created=false;
try{
  await admin.query(`CREATE DATABASE "${database}"`);created=true;source.pathname=`/${database}`;
  const env={...process.env,DATABASE_URL:source.toString(),NEEDWARE_HOSTED_GENERATION:'1',NEEDWARE_FIXTURE_MODE:'1',NEEDWARE_BILLING_MODE:'disabled',NEEDWARE_WORKER_MODE:'scheduled',NEEDWARE_WORKER_INTERVAL_SECONDS:'300'};
  const migration=spawnSync(process.execPath,['scripts/auth-migrate.mjs'],{env,stdio:'inherit'});assert.equal(migration.status,0);
  const deno=process.argv.includes('--deno');
  const test=spawnSync(deno?'npx':process.execPath,deno?['--yes','deno@2.9.6','run','--no-config','--no-lock','--node-modules-dir=manual','-A','scripts/scheduled-worker-fixture.mjs']:['scripts/scheduled-worker-fixture.mjs'],{env,stdio:'inherit',timeout:60000});assert.equal(test.status,0);
}finally{if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();}
