import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { loadEnvironment } from './load-environment.mjs';
loadEnvironment();
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Pool } = require('pg');
const source = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname)) {
  throw new Error('Account acceptance requires a local database; configured data preserved');
}
const database = `needware_acceptance_${randomBytes(16).toString('hex')}`;
const admin = new Pool({ connectionString: source.toString() });
let created = false;
try {
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  const isolated = new URL(source); isolated.pathname = `/${database}`;
  const result = spawnSync(process.execPath, ['scripts/verify_accounts.mjs'], {
    stdio: 'inherit', env: { ...process.env, DATABASE_URL: isolated.toString(), NEEDWARE_ACCEPTANCE_DATABASE: database,
      ...(process.argv.includes('--roots') ? { NEEDWARE_TEST_ROOT_FOCUS: '1' } : {}),
      ...(process.argv.includes('--revisions') ? { NEEDWARE_TEST_REVISION_FOCUS: '1' } : {}),
      ...(process.argv.includes('--registry') ? { NEEDWARE_TEST_REGISTRY_FOCUS: '1' } : {}),
      ...(process.argv.includes('--generation') ? { NEEDWARE_TEST_GENERATION_FOCUS: '1' } : {}),
      ...(process.argv.includes('--billing') ? { NEEDWARE_TEST_BILLING_FOCUS: '1' } : {}) },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  try { if (created) await admin.query(`DROP DATABASE "${database}"`); }
  finally { await admin.end(); }
}
