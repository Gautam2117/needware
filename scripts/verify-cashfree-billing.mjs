// Authored provider responses and real isolated PostgreSQL. No Cashfree calls.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {loadEnvironment} from './load-environment.mjs';
import {cashfreeCheckout,cashfreePrice,synchronizeCashfree,enqueueCashfreeEvent,processCashfreeEvent,cashfreeCancel,processCashfreeCleanup,reconcileCashfreeAccounts,cashfreePaidCandidate,cashfreeDate} from '../apps/web/lib/cashfree-store.ts';
import {verifyCashfreeWebhook} from '../apps/web/lib/cashfree-client.ts';
import {generationUsage} from '../apps/web/lib/generation-store.ts';
loadEnvironment();
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{Pool}=require('pg'),source=new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(source.hostname),'Local database required');
const database=`needware_cashfree_${randomBytes(16).toString('hex')}`,admin=new Pool({connectionString:source.toString()});let pool,created=false,workerResources;
const config={clientId:'authored-test-client',secret:'authored-sandbox-secret-for-fixtures-only',merchant:'cf_'+randomBytes(16).toString('hex'),plan:'needware_pro_monthly_499',amount:49900,live:false};
const plan={plan_id:config.plan,plan_status:'ACTIVE',plan_type:'PERIODIC',plan_currency:'INR',plan_interval_type:'MONTH',plan_intervals:1,plan_recurring_amount:499};
const records=new Map(),originalFetch=globalThis.fetch;let payments=[],refunds=[],disputes=[],upstreamFailure=false,wrongOrder=false,loseResponse=false,creates=0;
const pgOrder={order_id:'authored_order',cf_order_id:'3001',order_status:'PAID',order_currency:'INR',order_amount:499};
globalThis.fetch=async(input,options={})=>{
 const url=new URL(input);assert.equal(url.origin,'https://sandbox.cashfree.com');assert.equal(options.redirect,'error');assert.equal(options.headers['x-client-id'],config.clientId);
 if(upstreamFailure)return Response.json({code:'internal_server_error'},{status:500});
 const path=url.pathname.slice(3),method=options.method??'GET';
 if(path===`/plans/${config.plan}`)return Response.json(plan);
 if(path==='/subscriptions'&&method==='POST'){const body=JSON.parse(options.body);creates++;if(!records.has(body.subscription_id))records.set(body.subscription_id,{...body,cf_subscription_id:String(records.size+100),subscription_status:'INITIALIZED',subscription_session_id:'authored_session_for_local_fixture',plan_details:plan});if(loseResponse){loseResponse=false;throw Error('Authored lost response after provider commit');}return Response.json(records.get(body.subscription_id));}
 const match=/^\/subscriptions\/([^/]+)(.*)$/.exec(path);
 if(match){const record=records.get(match[1]);assert.ok(record,'Known fixture subscription');
  if(match[2]==='/manage'){assert.equal(JSON.parse(options.body).action,'CANCEL');record.subscription_status='CANCELLED';return Response.json(record);}
  if(match[2]==='/payments')return Response.json(payments);
  if(match[2].startsWith('/payments/'))return Response.json(payments.find(p=>p.payment_id===match[2].slice(10)));
  if(match[2].startsWith('/refunds/'))return Response.json({refund_id:match[2].slice(9),cf_payment_id:'2001',refund_status:'SUCCESS'});
  assert.equal(match[2],'');return Response.json(record);
 }
 if(path==='/orders/authored_order')return Response.json({...pgOrder,cf_order_id:wrongOrder?'unbound':pgOrder.cf_order_id});
 if(path==='/orders/authored_order/payments/4001')return Response.json({cf_payment_id:'4001',order_id:pgOrder.order_id,payment_status:'SUCCESS',is_captured:true,payment_currency:'INR',order_currency:'INR',order_amount:499,payment_amount:499});
 if(path==='/orders/authored_order/refunds')return Response.json(refunds);
 if(path==='/payments/4001/disputes')return Response.json(disputes);
 throw Error('Unexpected authored API path');
};
try{
 await admin.query(`CREATE DATABASE "${database}"`);created=true;source.pathname=`/${database}`;pool=new Pool({connectionString:source.toString(),max:8});
 const env={...process.env,DATABASE_URL:source.toString(),BETTER_AUTH_URL:'http://127.0.0.1:3108',SMTP_HOST:'127.0.0.1',NEEDWARE_BILLING_MODE:'cashfree',NEEDWARE_GENERATION_QUOTA:'',CASHFREE_ENVIRONMENT:'sandbox',CASHFREE_MERCHANT_ID:config.merchant,NEEDWARE_ACCEPTANCE_DATABASE:database};
 for(let i=0;i<2;i++)assert.equal(spawnSync(process.execPath,['scripts/auth-migrate.mjs'],{env,stdio:'inherit'}).status,0,'Migration and repeat migration');
 Object.assign(process.env,env);
 const owner=randomUUID(),other=randomUUID();for(const user of [owner,other])await pool.query('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[user,'Authored Billing QA',`${user}@needware.invalid`]);
 const id=randomUUID(),price=await cashfreePrice(config),checkout=()=>cashfreeCheckout(pool,owner,`${owner}@needware.invalid`,'Authored Billing QA','9900000000',id,price,config,env.BETTER_AUTH_URL);
 await assert.rejects(cashfreeCheckout(pool,owner,`${owner}@needware.invalid`,'Authored Billing QA','invalid',id,price,config,env.BETTER_AUTH_URL));assert.equal((await pool.query('SELECT count(*)::int AS n FROM needware_billing_account')).rows[0].n,0);
 const result=await checkout();assert.equal(result.provider,'cashfree');assert.deepEqual(await checkout(),result);assert.equal(creates,1,'Resume must not create another subscription');
 await assert.rejects(cashfreeCheckout(pool,owner,`${owner}@needware.invalid`,'Authored Billing QA','9900000000',randomUUID(),price,config,env.BETTER_AUTH_URL),/already exists/);
 await assert.rejects(cashfreeCheckout(pool,other,`${other}@needware.invalid`,'Authored Billing QA','9900000000',id,price,config,env.BETTER_AUTH_URL),/intent changed/);
 await assert.rejects(cashfreeCheckout(pool,owner,`${owner}@needware.invalid`,'Authored Billing QA','9900000000',id,price,{...config,live:true},env.BETTER_AUTH_URL));
 const subscription=[...records.values()][0],tx=async fn=>{const client=await pool.connect();try{await client.query('BEGIN');await fn(client);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}},sync=()=>tx(c=>synchronizeCashfree(c,owner,config));
 const entitlement=async()=>(await pool.query('SELECT plan,paid_until FROM needware_entitlement WHERE account_id=$1',[owner])).rows[0];
 await sync();assert.equal((await entitlement()).plan,'free');
 subscription.subscription_status='ACTIVE';const scheduled=new Date(Date.now()-60000).toISOString();
 const charge={subscription_id:subscription.subscription_id,cf_subscription_id:subscription.cf_subscription_id,cf_payment_id:'2001',cf_txn_id:'4001',cf_order_id:'3001',payment_id:'authored_payment',payment_type:'AUTH',payment_status:'SUCCESS',payment_amount:499,payment_schedule_date:scheduled,payment_initiated_date:scheduled};
 payments=[charge];await sync();assert.equal((await entitlement()).plan,'free','AUTH never grants access');charge.payment_type='CHARGE';await sync();assert.equal((await entitlement()).plan,'free','Missing PG order binding fails closed');
 const signed=(type,data)=>{const body=Buffer.from(JSON.stringify({type,event_time:new Date().toISOString(),data})),timestamp=String(Date.now()),signature=createHmac('sha256',config.secret).update(timestamp).update(body).digest('base64');assert.throws(()=>verifyCashfreeWebhook(config,body,timestamp,'A'.repeat(43)+'='));return verifyCashfreeWebhook(config,body,timestamp,signature);};
 const event=signed('PAYMENT_SUCCESS_WEBHOOK',{order:{order_id:pgOrder.order_id},payment:{cf_payment_id:'4001'}});
 await enqueueCashfreeEvent(pool,event,config);assert.equal(await processCashfreeEvent(pool,config),true);assert.equal((await entitlement()).plan,'pro');
 await enqueueCashfreeEvent(pool,event,config);assert.equal((await pool.query('SELECT count(*)::int AS n FROM needware_cashfree_event')).rows[0].n,1);assert.equal((await pool.query('SELECT status FROM needware_billing_account WHERE account_id=$1',[owner])).rows[0].status,'active','Processed duplicate does not revoke authority');
 assert.equal((await generationUsage(pool,owner)).plan,'pro');process.env.BETTER_AUTH_URL='https://needware.continuumarc.tech';assert.equal((await generationUsage(pool,owner)).plan,'free','Sandbox never grants production access');process.env.BETTER_AUTH_URL=env.BETTER_AUTH_URL;
 process.env.BETTER_AUTH_URL='https://needware.continuumarc.tech';process.env.CASHFREE_ENVIRONMENT='production';process.env.CASHFREE_LIVE_APPROVED='1';process.env.CASHFREE_LIVE_ACCEPTANCE_APPROVED='0';await pool.query('UPDATE needware_billing_account SET livemode=true WHERE account_id=$1',[owner]);assert.equal((await generationUsage(pool,owner)).plan,'free','Live approval alone cannot bypass final billing acceptance');process.env.CASHFREE_LIVE_ACCEPTANCE_APPROVED='1';assert.equal((await generationUsage(pool,owner)).plan,'pro');await pool.query('UPDATE needware_billing_account SET livemode=false WHERE account_id=$1',[owner]);process.env.CASHFREE_ENVIRONMENT='sandbox';process.env.CASHFREE_LIVE_APPROVED='0';process.env.CASHFREE_LIVE_ACCEPTANCE_APPROVED='0';process.env.BETTER_AUTH_URL=env.BETTER_AUTH_URL;
 wrongOrder=true;await sync();assert.equal((await entitlement()).plan,'free');wrongOrder=false;
 refunds=[{order_id:pgOrder.order_id,refund_status:'PENDING'}];await sync();assert.equal((await entitlement()).plan,'free');refunds=[];
 disputes=[{cf_payment_id:'4001',dispute_status:'DISPUTE_CREATED'}];await sync();assert.equal((await entitlement()).plan,'free');disputes=[];await sync();assert.equal((await entitlement()).plan,'pro');
 await pool.query("UPDATE needware_billing_account SET updated_at=now()-interval '16 minutes' WHERE account_id=$1",[owner]);upstreamFailure=true;await assert.rejects(reconcileCashfreeAccounts(pool,config));assert.equal((await generationUsage(pool,owner)).plan,'free','Periodic API failure immediately suspends authority');upstreamFailure=false;await sync();
 const refundEvent=signed('SUBSCRIPTION_REFUND_STATUS',{cf_payment_id:'2001',refund_id:'authored_refund'});await enqueueCashfreeEvent(pool,refundEvent,config);assert.equal((await generationUsage(pool,owner)).plan,'free','Notice immediately suspends stale authority');
 upstreamFailure=true;await assert.rejects(processCashfreeEvent(pool,config),/durable retry/);const retry=(await pool.query('SELECT attempts,processed_at,lease_id,failure FROM needware_cashfree_event WHERE id=$1',[refundEvent.id])).rows[0];assert.equal(retry.attempts,1);assert.equal(retry.processed_at,null);assert.equal(retry.lease_id,null);assert.equal(retry.failure,'RECONCILIATION_FAILED');
 upstreamFailure=false;await pool.query('UPDATE needware_cashfree_event SET next_attempt_at=now() WHERE id=$1',[refundEvent.id]);await processCashfreeEvent(pool,config);assert.equal((await entitlement()).plan,'free','Verified successful refund revokes access');
 await cashfreeCancel(pool,owner,config);assert.equal(subscription.subscription_status,'CANCELLED');assert.equal((await entitlement()).plan,'free');await assert.rejects(checkout(),/no longer pending/);
 const otherId=randomUUID(),otherCheckout=()=>cashfreeCheckout(pool,other,`${other}@needware.invalid`,'Authored Billing QA','9900000000',otherId,price,config,env.BETTER_AUTH_URL);loseResponse=true;await assert.rejects(otherCheckout());await otherCheckout();assert.equal(records.size,2,'Lost acknowledgment retries the same provider identity');await pool.query('DELETE FROM auth_user WHERE id=$1',[other]);assert.equal(await processCashfreeCleanup(pool,config),true);assert.equal([...records.values()][1].subscription_status,'CANCELLED','Deletion has durable provider cleanup');
 const stripeOwner=randomUUID();await pool.query('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[stripeOwner,'Existing Stripe QA',`${stripeOwner}@needware.invalid`]);await pool.query("INSERT INTO needware_billing_account(account_id,customer_id,merchant_id,livemode) VALUES($1,'cus_existing','acct_existing',false)",[stripeOwner]);await assert.rejects(cashfreeCheckout(pool,stripeOwner,`${stripeOwner}@needware.invalid`,'Existing Stripe QA','9900000000',randomUUID(),price,config,env.BETTER_AUTH_URL),/provider or environment/);
 assert.equal(cashfreePaidCandidate(config,{...subscription,subscription_status:'ACTIVE'},[{...charge,payment_amount:500}]),null);
 assert.equal(cashfreeDate('2026-10-07T12:00:00'),Date.parse('2026-10-07T12:00:00+05:30'));
 Object.assign(process.env,{CASHFREE_CLIENT_ID:config.clientId,CASHFREE_CLIENT_SECRET:config.secret,CASHFREE_PRO_PLAN_ID:config.plan,CASHFREE_PRO_MONTHLY_PAISE:String(config.amount)});
 const {runBillingWorker}=await import('./billing-worker.mjs');workerResources=(await import('../apps/web/lib/auth-options.ts')).authResources();const options={once:true,reuseResources:true,scheduleSeconds:300},health=async()=>(await pool.query("SELECT state FROM needware_worker_health WHERE worker='billing' ORDER BY updated_at DESC,instance DESC LIMIT 1")).rows[0].state;
 const late=signed('SUBSCRIPTION_STATUS_CHANGED',{subscription_id:subscription.subscription_id});await enqueueCashfreeEvent(pool,late,config);upstreamFailure=true;await runBillingWorker(options);assert.equal(await health(),'degraded');await pool.query("UPDATE needware_cashfree_event SET next_attempt_at=now()+interval '1 hour' WHERE id=$1",[late.id]);await runBillingWorker(options);assert.equal(await health(),'degraded','Empty tick cannot clear earlier failure');upstreamFailure=false;await pool.query('UPDATE needware_cashfree_event SET next_attempt_at=now() WHERE id=$1',[late.id]);await runBillingWorker(options);assert.equal(await health(),'idle','Successful reconciliation restores scheduled health');
 console.log('PASS authored Cashfree lifecycle: real PostgreSQL, repeat migration, checkout replay and isolation, AUTH denial, verified payment/order mapping, sandbox isolation, refund/dispute revocation, durable retry/cancellation/deletion');
}finally{globalThis.fetch=originalFetch;if(workerResources){workerResources.mail.close();await workerResources.pool.end();}if(pool)await pool.end();if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();}
