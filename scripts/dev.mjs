import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
const environment = { ...process.env };
for (const file of ['.env', '.local/dev.env']) if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) {
  const match = line.match(/^([A-Z][A-Z_0-9]*)=(.*)$/); if (match && match[2] && environment[match[1]] === undefined) environment[match[1]] = match[2];
}
environment.NEEDWARE_CONTROL_TOKEN ||= randomBytes(32).toString('hex');
mkdirSync('.logs', { recursive: true });
const start = (name, command, args) => {
  const log = createWriteStream(`.logs/${name}-dev.log`, { flags: 'a' });
  const child = spawn(command, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log); return child;
};
const control = start('control', 'cargo', ['run', '-p', 'needware-control-plane']);
const web = start('web', 'pnpm', ['--filter', '@needware/web', 'dev']);
let stopping = false;
function stop(code) { if (stopping) return; stopping = true; control.kill('SIGINT'); web.kill('SIGINT'); process.exitCode = code; }
control.on('exit', code => stop(code ?? 1)); web.on('exit', code => stop(code ?? 1));
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));
console.log('Needware dev starting on http://127.0.0.1:3000; logs: .logs/web-dev.log and .logs/control-dev.log');
