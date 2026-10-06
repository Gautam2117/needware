import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {backupConfig,backupDatabase,restoreDatabase} from './backup-lib.mjs';
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{Pool}=require('pg');
const url=new URL(process.env.DATABASE_URL);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55437');assert.equal(url.pathname,'/postgres');
const admin=new Pool({connectionString:url.toString(),max:1}),suffix=randomBytes(12).toString('hex');
const names=['source','target','occupied'].map(kind=>`needware_backup_${kind}_${suffix}`);
const created=[],pools=[],key=randomBytes(32),directory=await mkdtemp(join(tmpdir(),'needware-scope-test-'));
try{
  assert.equal(Math.floor(Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version)/10000),17);
  for(const name of names){await admin.query(`CREATE DATABASE "${name}"`);created.push(name);const u=new URL(url);u.pathname=`/${name}`;pools.push(new Pool({connectionString:u.toString(),max:1}));}
  const [source,target,occupied]=pools;
  await source.query(`CREATE TABLE public.fixture(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body bytea NOT NULL, metadata jsonb NOT NULL);
    CREATE VIEW public.fixture_view AS SELECT id, metadata FROM public.fixture;
    CREATE FUNCTION public.fixture_constant() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 7';
    CREATE SCHEMA managed_fixture; CREATE TABLE managed_fixture.sentinel(secret text); INSERT INTO managed_fixture.sentinel VALUES ('outside-Needware');`);
  await source.query('INSERT INTO public.fixture(body,metadata) VALUES ($1,$2),($3,$4)',[randomBytes(128),{epoch:1,keys:['a','b']},randomBytes(128),{epoch:2,nested:{value:'ciphertext'}}]);
  const fingerprint=async pool=>(await pool.query('SELECT id::text, encode(body,\'hex\') AS body, metadata FROM public.fixture ORDER BY id')).rows;
  const before=await fingerprint(source);
  await target.query("CREATE SCHEMA managed_fixture; CREATE TABLE managed_fixture.sentinel(secret text); INSERT INTO managed_fixture.sentinel VALUES ('target-managed-untouched')");
  await occupied.query('CREATE TABLE public.preserved(value text); INSERT INTO public.preserved VALUES (\'untouched\')');
  const config=name=>{const u=new URL(url);u.pathname=`/${name}`;return backupConfig({...process.env,DATABASE_URL:u.toString(),NEEDWARE_BACKUP_KEY:key.toString('hex')});};
  const configs=names.map(config),[from,to,held]=configs,artifact=join(directory,'public.needbk');
  try{
    await assert.rejects(backupDatabase(artifact,from),/explicit public-schema/);
    await assert.rejects(backupDatabase(artifact,from,{scope:'unknown'}),/Unknown backup/);
    await writeFile(join(directory,'pg_dump'),"#!/bin/sh\nprintf 'pg_dump (PostgreSQL) 16.0\\n'\n",{mode:0o700});await chmod(join(directory,'pg_dump'),0o700);
    await assert.rejects(backupDatabase(artifact,{...from,path:directory},{scope:'public'}),/Matching PostgreSQL 17/);
    await backupDatabase(artifact,from,{scope:'public'});
    const bytes=await readFile(artifact),empty=async()=>assert.equal(Number((await target.query("SELECT count(*) AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public'")).rows[0].n),0);
    await assert.rejects(restoreDatabase(artifact,to),/explicit public-schema/);await empty();
    await target.query("CREATE TYPE public.preserved_type AS ENUM ('untouched')");
    await assert.rejects(restoreDatabase(artifact,to,{scope:'public'}),/separate empty/);
    assert.equal((await target.query("SELECT count(*)::int AS n FROM pg_type t JOIN pg_namespace ns ON ns.oid=t.typnamespace WHERE ns.nspname='public' AND t.typname='preserved_type'")).rows[0].n,1);
    await target.query('DROP TYPE public.preserved_type');
    const wrong=randomBytes(32);try{await assert.rejects(restoreDatabase(artifact,{...to,key:wrong},{scope:'public'}),/authentication failed/);await empty();}finally{wrong.fill(0);}
    for(const offset of [0,8,20,bytes.length-1]){const corrupt=Buffer.from(bytes);corrupt[offset]^=1;const path=join(directory,`tampered-${offset}`);await writeFile(path,corrupt,{mode:0o600});await assert.rejects(restoreDatabase(path,to,{scope:'public'}),/authentication failed/);await empty();}
    await assert.rejects(restoreDatabase(artifact,held,{scope:'public'}),/separate empty/);
    assert.equal((await occupied.query('SELECT value FROM public.preserved')).rows[0].value,'untouched');
    await admin.query(`ALTER DATABASE "${names[1]}" SET default_transaction_read_only=on`);
    await assert.rejects(restoreDatabase(artifact,to,{scope:'public'}));await empty();
    await admin.query(`ALTER DATABASE "${names[1]}" RESET default_transaction_read_only`);
    await restoreDatabase(artifact,to,{scope:'public'});
    assert.deepEqual(await fingerprint(target),before);assert.deepEqual(await fingerprint(source),before);
    assert.equal((await target.query('SELECT public.fixture_constant() AS n')).rows[0].n,7);
    assert.equal((await target.query('SELECT count(*)::int AS n FROM public.fixture_view')).rows[0].n,2);
    assert.equal((await target.query('SELECT secret FROM managed_fixture.sentinel')).rows[0].secret,'target-managed-untouched');
    assert.equal((await source.query('SELECT secret FROM managed_fixture.sentinel')).rows[0].secret,'outside-Needware');
    await target.query('INSERT INTO public.fixture(body,metadata) VALUES ($1,$2)',[randomBytes(8),{}]);
    assert.equal((await target.query('SELECT max(id)::text AS n FROM public.fixture')).rows[0].n,'3');
    await assert.rejects(restoreDatabase(artifact,to,{scope:'public'}),/separate empty/);
    console.log('PASS PostgreSQL 17 public scope: ciphertext/JSON, schema/view/function/identity restore, managed-schema exclusion, wrong-tool/key/tamper/nonempty-target denial, source preservation');
  }finally{for(const c of configs)c.key.fill(0);}
}finally{
  for(const pool of pools)await pool.end();
  for(const name of created)await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();key.fill(0);await rm(directory,{recursive:true,force:true});
}
