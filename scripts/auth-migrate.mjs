import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadEnvironment } from './load-environment.mjs';
import {migrationFiles,verifyMigrationFiles,assertPriorSchema,recordSchemaReadiness} from './schema-readiness.mjs';
// Run with configured environment; no reset/drop operation is performed.
loadEnvironment();
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { getMigrations } = await import(require.resolve('better-auth/db/migration'));
const { default: canonicalize } = await import(require.resolve('canonicalize'));
const { authResources } = await import('../apps/web/lib/auth-options.ts');
const { options, pool } = authResources();
try {
  const files=await migrationFiles();
  await verifyMigrationFiles(pool,files);
  await assertPriorSchema(pool);
  const migrations = await getMigrations(options);
  if (migrations.unsafeChanges.length || migrations.schemaProblems.length) throw new Error('Unsafe account migration requires a reviewed repair');
  const sql = await migrations.compileMigrations();
  if (process.argv.includes('--emit') && sql.trim()) await writeFile('services/control-plane/migrations/auth-schema.sql', sql);
  await migrations.runMigrations();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1745,1)');
    await verifyMigrationFiles(client,files);await assertPriorSchema(client);
    const recorded=(await client.query("SELECT to_regclass('public.needware_schema_migration') IS NOT NULL AS present")).rows[0].present;
    const applied=new Set(recorded?(await client.query('SELECT name FROM needware_schema_migration')).rows.map(row=>row.name):[]);
    // Immutable old migrations must not reinstall superseded constraints over
    // newer billing rows. The new batch and readiness manifest commit together.
    for(const file of files.filter(file=>/^\d{4}-/.test(file.name))){
      if(!applied.has(file.name))await client.query(await readFile('services/control-plane/migrations/'+file.name,'utf8'));
    }
    // Existing charges already include this metadata. Record their exact size
    // without charging twice; canonical JSON differs from PostgreSQL jsonb text.
    const documents = await client.query('SELECT id FROM needware_document ORDER BY id FOR UPDATE');
    for (const { id } of documents.rows) {
      const members = await client.query('SELECT account_id,device_id,membership,key_envelope FROM needware_document_member WHERE document_id=$1 AND metadata_bytes=0 FOR UPDATE', [id]);
      for (const member of members.rows) {
        const size = Buffer.byteLength(canonicalize(member.membership)) + Buffer.byteLength(canonicalize(member.key_envelope));
        await client.query('UPDATE needware_document_member SET metadata_bytes=$4 WHERE document_id=$1 AND account_id=$2 AND device_id=$3', [id, member.account_id, member.device_id, size]);
      }
    }
    await recordSchemaReadiness(client,files);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  console.log('PASS account schema and durable email outbox migrations');
} finally { await pool.end(); }
