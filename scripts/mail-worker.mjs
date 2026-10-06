import { loadEnvironment } from './load-environment.mjs';
import {pathToFileURL} from 'node:url';
loadEnvironment();
export async function runMailWorker({once=false,reuseResources=false,scheduleSeconds=0}={}){
if((reuseResources||scheduleSeconds)&&!once)throw Error('Reusable scheduled workers must be bounded');
const { authResources } = await import('../apps/web/lib/auth-options.ts');
const { pool, mail, from } = authResources();
const {startWorkerHealth}=await import('../apps/web/lib/worker-health.ts'),health=await startWorkerHealth(pool,'email',scheduleSeconds);
const labels = { verify: 'Verify your Needware email', reset: 'Reset your Needware password', delete: 'Confirm Needware account deletion' };
let stopped = false;
const stop=()=>{stopped=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
async function deliver() {
  await pool.query('DELETE FROM needware_email_outbox WHERE expires_at < now()');
  const lease = crypto.randomUUID();
  const { rows } = await pool.query(`WITH candidate AS (
    SELECT id FROM needware_email_outbox WHERE next_attempt_at <= now() AND attempts < 20
    AND (lease_until IS NULL OR lease_until < now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE needware_email_outbox SET lease_id=$1, lease_until=now()+interval '30 seconds', attempts=attempts+1
    WHERE id IN (SELECT id FROM candidate) RETURNING *`, [lease]);
  if (!rows.length) return false;
  const job = rows[0];
  try {
    await mail.sendMail({ from, to: job.recipient, subject: labels[job.kind],
      text: `${labels[job.kind]}\n\n${job.link}\n\nIf you did not request this, ignore this email. Password reset does not recover encrypted data.` });
    await pool.query('DELETE FROM needware_email_outbox WHERE id=$1 AND lease_id=$2', [job.id, lease]);
    health.healthy();
  } catch (error) {
    health.degraded();
    const delay = Math.min(3600, 2 ** Math.min(job.attempts, 12));
    await pool.query(`UPDATE needware_email_outbox SET lease_id=NULL, lease_until=NULL,
      next_attempt_at=now()+($3 * interval '1 second'), last_error='DELIVERY_FAILED' WHERE id=$1 AND lease_id=$2`, [job.id, lease, delay]);
    // No recipient, verification link, SMTP credentials or provider error text enters logs.
    const code = typeof error?.code === 'string' && /^(?:E[A-Z_]{1,24}|[0-9]{5})$/.test(error.code) ? error.code : 'UNKNOWN';
    const response = Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode <= 599 ? error.responseCode : 0;
    console.error(`Email delivery failed; durable retry scheduled code=${code} smtp=${response}`);
  }
  return true;
}
try {
  do {
    const worked = await deliver();
    if (once) break;
    if (!worked) await new Promise(resolve => setTimeout(resolve, 1000));
  } while (!stopped);
  } catch(error){health.degraded();throw error;} finally { process.off('SIGINT',stop);process.off('SIGTERM',stop);await health.stop();if(!reuseResources){mail.close();await pool.end();} }
}
if(import.meta.main||import.meta.url===pathToFileURL(process.argv[1]??'').href)await runMailWorker({once:process.argv.includes('--once')});
