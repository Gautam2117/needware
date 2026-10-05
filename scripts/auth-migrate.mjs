import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadEnvironment } from './load-environment.mjs';
// Run with configured environment; no reset/drop operation is performed.
loadEnvironment();
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { getMigrations } = await import(require.resolve('better-auth/db/migration'));
const { default: canonicalize } = await import(require.resolve('canonicalize'));
const { authResources } = await import('../apps/web/lib/auth-options.ts');
const { options, pool } = authResources();
try {
  const migrations = await getMigrations(options);
  if (migrations.unsafeChanges.length || migrations.schemaProblems.length) throw new Error('Unsafe account migration requires a reviewed repair');
  const sql = await migrations.compileMigrations();
  if (process.argv.includes('--emit') && sql.trim()) await writeFile('services/control-plane/migrations/auth-schema.sql', sql);
  await migrations.runMigrations();
  await pool.query(await readFile('services/control-plane/migrations/0001-email-outbox.sql', 'utf8'));
  await pool.query(await readFile('services/control-plane/migrations/0002-account-vault.sql', 'utf8'));
  await pool.query(await readFile('services/control-plane/migrations/0003-document-relay.sql', 'utf8'));
  await pool.query(await readFile('services/control-plane/migrations/0004-document-epochs.sql', 'utf8'));
  await pool.query(await readFile('services/control-plane/migrations/0005-epoch-recipient-certificates.sql', 'utf8'));
  await pool.query(await readFile('services/control-plane/migrations/0006-account-root-rotation.sql', 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  console.log('PASS account schema and durable email outbox migrations');
} finally { await pool.end(); }
