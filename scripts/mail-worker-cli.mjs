import {loadEnvironment} from './load-environment.mjs';
// Local/CLI-only entrypoint. The Next.js API imports the pure worker module,
// never a filesystem-scanning local .env loader during its server build.
loadEnvironment();
const {runMailWorker}=await import('./mail-worker.mjs');
await runMailWorker({once:process.argv.includes('--once')});
