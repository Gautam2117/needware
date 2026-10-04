import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fixture = mkdtempSync(join(tmpdir(), 'needware-environment-'));
try {
  mkdirSync(join(fixture, '.local'));
  copyFileSync(new URL('../.env.example', import.meta.url), join(fixture, '.env'));
  writeFileSync(join(fixture, '.local/dev.env'), 'SMTP_HOST=127.0.0.1\nSMTP_PORT=51025\n', { mode: 0o600 });
  const loader = new URL('./load-environment.mjs', import.meta.url).href;
  const source = `import {loadEnvironment} from ${JSON.stringify(loader)}; loadEnvironment(); console.log(JSON.stringify([process.env.SMTP_HOST, process.env.SMTP_PORT]));`;
  const load = env => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: fixture, env, encoding: 'utf8' }));
  assert.deepEqual(load({}), ['127.0.0.1', '51025']);
  assert.deepEqual(load({ SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: '2525' }), ['smtp.example.invalid', '2525']);
  writeFileSync(join(fixture, '.env'), 'SMTP_HOST=smtp.example.invalid\nSMTP_PORT=587\n');
  assert.deepEqual(load({}), ['smtp.example.invalid', '587']);
  console.log('Fresh bootstrap Mailpit and explicit SMTP precedence PASS');
} finally { rmSync(fixture, { recursive: true, force: true }); }
