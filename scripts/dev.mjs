import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { loadEnvironment } from './load-environment.mjs';
loadEnvironment();
const environment = { ...process.env };
environment.NEEDWARE_CONTROL_TOKEN ||= randomBytes(32).toString('hex');
mkdirSync('.logs', { recursive: true });
const start = (name, command, args) => {
  const log = createWriteStream(`.logs/${name}-dev.log`, { flags: 'a' });
  const child = spawn(command, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log); return child;
};
const accountsConfigured = Boolean(environment.DATABASE_URL && environment.BETTER_AUTH_SECRET && environment.SMTP_HOST);
if (accountsConfigured) {
  const migration = start('auth-migrate', 'node', ['scripts/auth-migrate.mjs']);
  const code = await new Promise(resolve => migration.once('exit', resolve));
  if (code !== 0) throw new Error('Account migration failed; inspect .logs/auth-migrate-dev.log');
}
const control = start('control', 'cargo', ['run', '-p', 'needware-control-plane']);
const mail = accountsConfigured ? start('mail', 'node', ['scripts/mail-worker.mjs']) : undefined;
const web = start('web', 'pnpm', ['--filter', '@needware/web', 'dev']);
let stopping = false;
function stop(code) { if (stopping) return; stopping = true; control.kill('SIGINT'); web.kill('SIGINT'); mail?.kill('SIGINT'); process.exitCode = code; }
control.on('exit', code => stop(code ?? 1)); web.on('exit', code => stop(code ?? 1));
mail?.on('exit', code => stop(code ?? 1));
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));
console.log('Needware dev starting on http://127.0.0.1:3000; logs: .logs/web-dev.log and .logs/control-dev.log');
