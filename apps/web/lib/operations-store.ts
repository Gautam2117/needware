import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {CloudError} from './cloud-request';
import {object,uuid} from './vault-proof';
import {operatorAllowed} from './operations-authority';
import {ownerLock} from './generation-store';
import {billingEnabled} from './billing-policy';
import {workerHealthQuery} from './worker-health-query';
export const reportReasons=['harmful','privacy','spam','copyright'] as const;
const reason=(value:unknown)=>{if(!reportReasons.includes(value as typeof reportReasons[number]))throw new CloudError(400,'Choose a report reason');return value as string;};
export function requireOperator(account:string){
  if(!operatorAllowed(account,process.env.NEEDWARE_OPERATOR_ACCOUNTS??''))throw new CloudError(403,'Operator access is unavailable');
}
async function reportLock(client:PoolClient,actor:string){if(!(await client.query('SELECT id FROM auth_user WHERE id=$1 FOR KEY SHARE',[actor])).rowCount)throw new CloudError(404,'Account unavailable');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1745))',[actor]);}
export async function reportApplication(pool:Pool,actor:string,payload:unknown){
  const value=object(payload,['entry','reason']),entry=uuid(value.entry),code=reason(value.reason),client=await pool.connect();
  try{await client.query('BEGIN');await reportLock(client,actor);
    if(!(await client.query("SELECT id FROM needware_registry_entry WHERE id=$1 AND visibility<>'private' FOR SHARE",[entry])).rowCount)throw new CloudError(404,'Application unavailable');
    await client.query("DELETE FROM needware_abuse_report WHERE reporter_id=$1 AND state='reviewed' AND reviewed_at<now()-interval '30 days'",[actor]);
    const old=await client.query('SELECT id FROM needware_abuse_report WHERE reporter_id=$1 AND entry_id=$2',[actor,entry]);if(old.rowCount){await client.query('COMMIT');return {id:old.rows[0].id,received:true};}
    const count=(await client.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '1 day')::int AS daily FROM needware_abuse_report WHERE reporter_id=$1",[actor])).rows[0];
    if(count.total>=128||count.daily>=10)throw new CloudError(429,'Report limit reached; try again later');
    const id=randomUUID();await client.query('INSERT INTO needware_abuse_report(id,reporter_id,entry_id,reason) VALUES($1,$2,$3,$4)',[id,actor,entry,code]);await client.query('COMMIT');return {id,received:true};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function operate(pool:Pool,actor:string,payload:unknown){
  requireOperator(actor);const value=object(payload,['action','id','expected_version','reason']),id=uuid(value.id),code=reason(value.reason);
  if(!['hide','restore','review_report','inspect','hold_account','release_account'].includes(String(value.action))||!Number.isSafeInteger(value.expected_version)||Number(value.expected_version)<0)throw new CloudError(400,'Invalid operator review');
  const client=await pool.connect();try{await client.query('BEGIN');await reportLock(client,actor);let before:number|null=null,after:number|null=null,definition:string|null=null;
    if(value.action==='hold_account'||value.action==='release_account'){if(!(await client.query('SELECT id FROM auth_user WHERE id=$1 FOR KEY SHARE',[id])).rowCount)throw new CloudError(404,'Account unavailable');await ownerLock(client,id);const prior=(await client.query('SELECT version FROM needware_account_hold WHERE account_id=$1 FOR UPDATE',[id])).rows[0];before=Number(prior?.version??0);if(before!==value.expected_version)throw new CloudError(409,'Account hold changed; review the current hold first');after=before+1;
      await client.query('INSERT INTO needware_account_hold(account_id,active,reason) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET active=EXCLUDED.active,reason=EXCLUDED.reason,version=needware_account_hold.version+1,updated_at=now()',[id,value.action==='hold_account',code]);
      await client.query('UPDATE needware_registry_entry SET version=version+1,updated_at=now() WHERE owner_id=$1',[id]);if(value.action==='hold_account')await client.query("UPDATE needware_generation_job SET state='cancel_requested' WHERE owner_id=$1 AND state='running'",[id]);
    }else if(value.action==='review_report'){if(value.expected_version!==0)throw new CloudError(400,'Invalid report review');const result=await client.query("UPDATE needware_abuse_report SET state='reviewed',reviewed_at=now() WHERE id=$1 AND state='open' AND reason=$2 RETURNING id",[id,code]);if(!result.rowCount)throw new CloudError(409,'Report changed; reload before reviewing');}
    else{const result=await client.query('SELECT version,visibility FROM needware_registry_entry WHERE id=$1 FOR UPDATE',[id]);if(!result.rowCount||result.rows[0].visibility==='private')throw new CloudError(404,'Published application unavailable');before=Number(result.rows[0].version);if(before!==value.expected_version)throw new CloudError(409,'Application changed; review the current revision first');after=value.action==='inspect'?before:before+1;
      if(value.action==='inspect'){const packageRow=await client.query('SELECT r.package FROM needware_registry_revision r JOIN needware_registry_entry e ON e.id=r.entry_id AND e.current_digest=r.digest WHERE e.id=$1',[id]);if(!packageRow.rows[0]?.package)throw new CloudError(404,'Published definition unavailable');definition=packageRow.rows[0].package.toString('base64');}
      else await client.query('UPDATE needware_registry_entry SET moderated=$2,moderation_reason=$3,version=version+1,updated_at=now() WHERE id=$1',[id,value.action==='hide',value.action==='hide'?code:null]);}
    await client.query('INSERT INTO needware_operator_audit(id,operator_id,object_id,action,reason,before_version,after_version) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor,id,value.action,code,before,after]);await client.query('COMMIT');return {reviewed:true,version:after,...(definition?{definition}:{})};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function operationsSummary(pool:Pool,actor:string){
  const healthQuery=workerHealthQuery();
  requireOperator(actor);const [reports,audit,workers,queues,holds,deadLetters]=await Promise.all([
    pool.query(`SELECT r.id,r.entry_id,r.reason,r.created_at,e.title,e.current_digest,e.version,e.moderated FROM needware_abuse_report r JOIN needware_registry_entry e ON e.id=r.entry_id WHERE r.state='open' ORDER BY r.created_at,r.id LIMIT 128`),
    pool.query('SELECT object_id,action,reason,reference_digest,before_version,after_version,created_at FROM needware_operator_audit ORDER BY created_at DESC,id LIMIT 128'),
    pool.query(`SELECT w.worker,bool_or(${healthQuery.sql}) AS healthy,max(w.updated_at) AS last_seen FROM needware_worker_health w GROUP BY w.worker`,healthQuery.values),
    pool.query(`SELECT (SELECT count(*)::int FROM needware_email_outbox WHERE attempts>=20) AS email_dead_letters,(SELECT count(*)::int FROM needware_generation_job WHERE state IN ('queued','running','cancel_requested')) AS generation_pending,(SELECT count(*)::int FROM needware_generation_job WHERE failure='INTERRUPTED_USAGE_UNKNOWN') AS generation_unknown,(SELECT count(*)::int FROM needware_billing_event WHERE processed_at IS NULL AND attempts>=20) AS billing_dead_letters,(SELECT count(*)::int FROM needware_billing_cleanup WHERE finished_at IS NULL AND attempts>=20) AS deletion_dead_letters`),
    pool.query('SELECT account_id,active,reason,version FROM needware_account_hold ORDER BY updated_at DESC,account_id LIMIT 128'),
    pool.query(`SELECT * FROM (SELECT 'email' AS worker,id::text AS reference,created_at FROM needware_email_outbox WHERE attempts>=20 AND expires_at>now() UNION ALL SELECT 'billing_event',id,received_at FROM needware_billing_event WHERE attempts>=20 AND processed_at IS NULL AND merchant_id=$1 AND livemode=$2 UNION ALL SELECT 'billing_cleanup',customer_id,created_at FROM needware_billing_cleanup WHERE attempts>=20 AND finished_at IS NULL AND merchant_id=$1 AND livemode=$2) q ORDER BY created_at,reference LIMIT 128`,[process.env.STRIPE_ACCOUNT_ID??'',process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')??false])
  ]);const required=['email',...(process.env.NEEDWARE_HOSTED_GENERATION==='1'?['generation']:[]),...(billingEnabled()&&process.env.STRIPE_SECRET_KEY?['billing']:[])],health=[...new Set([...required,...workers.rows.map(row=>row.worker)])].map(worker=>workers.rows.find(row=>row.worker===worker)??{worker,healthy:false,last_seen:null});return {reports:reports.rows,audit:audit.rows,workers:health,queues:queues.rows[0],holds:holds.rows,dead_letters:deadLetters.rows};
}
export async function retryWorker(pool:Pool,actor:string,payload:unknown){
  requireOperator(actor);const value=object(payload,['action','worker','reference','expected_attempts']);if(value.action!=='retry_worker'||value.expected_attempts!==20||!['email','billing_event','billing_cleanup'].includes(String(value.worker)))throw new CloudError(400,'Invalid retained worker retry');
  const worker=value.worker as 'email'|'billing_event'|'billing_cleanup',reference=worker==='email'?uuid(value.reference):typeof value.reference==='string'&&new RegExp(worker==='billing_event'?'^evt_[A-Za-z0-9]{1,96}$':'^cus_[A-Za-z0-9]{1,96}$').test(value.reference)?value.reference:null;if(!reference)throw new CloudError(400,'Invalid retained job reference');
  const spec={email:{table:'needware_email_outbox',key:'id',valid:'expires_at>now()',failure:'last_error'},billing_event:{table:'needware_billing_event',key:'id',valid:'processed_at IS NULL AND merchant_id=$2 AND livemode=$3',failure:'failure'},billing_cleanup:{table:'needware_billing_cleanup',key:'customer_id',valid:'finished_at IS NULL AND merchant_id=$2 AND livemode=$3',failure:'failure'}}[worker],parameters:unknown[]=[reference];
  if(worker!=='email'){if(!billingEnabled()||!process.env.STRIPE_ACCOUNT_ID||!process.env.STRIPE_SECRET_KEY)throw new CloudError(503,'Configure the original Stripe account and mode before retrying');parameters.push(process.env.STRIPE_ACCOUNT_ID,process.env.STRIPE_SECRET_KEY.startsWith('sk_live_'));}
  const client=await pool.connect();try{await client.query('BEGIN');await reportLock(client,actor);const updated=await client.query(`UPDATE ${spec.table} SET attempts=0,next_attempt_at=now(),lease_id=NULL,lease_until=NULL,${spec.failure}=NULL WHERE ${spec.key}=$1 AND attempts=20 AND (${spec.valid}) AND (lease_until IS NULL OR lease_until<now()) RETURNING ${spec.key}`,parameters);if(!updated.rowCount)throw new CloudError(409,'Retained job changed, expired or belongs to another installation');
    const digest=createHash('sha256').update(`${worker}:${reference}`).digest('hex'),opaque=`${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`;await client.query("INSERT INTO needware_operator_audit(id,operator_id,object_id,action,reason,reference_digest,before_version,after_version) VALUES($1,$2,$3,'retry_worker','transient_failure',$4,20,0)",[randomUUID(),actor,opaque,digest]);await client.query('COMMIT');return {retried:true};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
