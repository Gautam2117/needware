// Isolated end-to-end HTTP contracts with conspicuous fixture labeling and zero inference cost.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
mkdirSync('.logs', { recursive: true });
execFileSync('cargo', ['run', '-p', 'xtask', '--', 'compiler-fixture'], { stdio: 'inherit' });
execFileSync('cargo', ['build', '-p', 'needware-control-plane'], { stdio: 'inherit' });
const environment = { ...process.env, NEEDWARE_PROVIDER: 'local', NEEDWARE_MODEL: 'contract-fixture', NEEDWARE_LOCAL_API_KEY: '', NEEDWARE_LOCAL_ENDPOINT: 'http://127.0.0.1:11435/v1/chat/completions', NEEDWARE_ALLOW_LOOPBACK: '1', NEEDWARE_FIXTURE_MODE: '1', NEEDWARE_INPUT_MICROUSD_PER_MILLION: '0', NEEDWARE_OUTPUT_MICROUSD_PER_MILLION: '0', NEEDWARE_CONTROL_TOKEN: randomBytes(32).toString('hex'), NEEDWARE_CONTROL_PORT: '3111', NEEDWARE_CONTROL_URL: 'http://127.0.0.1:3111', NEEDWARE_PUBLIC_ORIGIN: 'http://127.0.0.1:3110', NEEDWARE_TEST_URL: 'http://127.0.0.1:3110', NEEDWARE_FIXTURE_DELAY_MS: '400' };
const children = [];
function start(name, command, args) {
  const log = createWriteStream(`.logs/compiler-${name}.log`, { flags: 'a' });
  const child = spawn(command, args, { env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.closed = new Promise(resolve => child.once('close', resolve));
  child.stdout.pipe(log); child.stderr.pipe(log); children.push(child); return child;
}
async function ready(url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (children.some(child => child.exitCode !== null)) throw new Error('Compiler contract server exited; see .logs/compiler-*.log');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Startup still in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Contract server did not start: ${url}`);
}
try {
  start('provider', 'node', ['tests/fixtures/provider-server.mjs']);
  start('control', 'target/debug/needware-control-plane', []);
  await ready('http://127.0.0.1:3111/health/live');
  const directory = mkdtempSync('artifacts/cli-contract-');
  const prompt = `${directory}/prompt.txt`, output = `${directory}/result.need`;
  writeFileSync(prompt, 'Track habits');
  execFileSync('cargo', ['run', '-p', 'needware-cli', '--', 'compile', prompt, output], { env: environment, stdio: 'inherit' });
  execFileSync('cargo', ['run', '-p', 'needware-cli', '--', 'verify', output], { env: environment, stdio: 'inherit' });
  start('web', 'pnpm', ['--filter', '@needware/web', 'start', '--port', '3110']);
  await ready('http://127.0.0.1:3110');
  const test = spawn('pnpm', ['exec', 'playwright', 'test', 'compiler.spec.ts', '--workers=1'], { env: environment, stdio: 'inherit' });
  process.exitCode = await new Promise(resolve => test.once('exit', code => resolve(code ?? 1)));
} finally {
  const signal = (child, name) => {
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  // pnpm may exit before its Next.js child. Terminate the owned process group,
  // then wait for inherited output pipes to close before leaving the runner.
  await Promise.all(children.map(async child => {
    signal(child, 'SIGTERM');
    const deadline = setTimeout(() => signal(child, 'SIGKILL'), 2000);
    try { await child.closed; } finally { clearTimeout(deadline); }
  }));
}
