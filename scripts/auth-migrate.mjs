import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadEnvironment } from './load-environment.mjs';
// Run with configured environment; no reset/drop operation is performed.
loadEnvironment();
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { getMigrations } = await import(require.resolve('better-auth/db/migration'));
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
  console.log('PASS account schema and durable email outbox migrations');
} finally { await pool.end(); }
