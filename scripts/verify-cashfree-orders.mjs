// Authored provider responses with a disposable real PostgreSQL database.
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID,createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {loadEnvironment} from './load-environment.mjs';
import {cashfreeConfig,verifyCashfreeWebhook} from '../apps/web/lib/cashfree-client.ts';
import {cashfreePassPrice,cashfreeOrderCheckout,synchronizeCashfreePass,enqueueCashfreeOrderEvent,processCashfreeOrderEvent,reconcileCashfreePassAccounts} from '../apps/web/lib/cashfree-orders.ts';
import {generationUsage} from '../apps/web/lib/generation-store.ts';
loadEnvironment();
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{Pool}=require('pg'),source=new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(source.hostname),'Local database required');
const database='needware_orders_'+randomBytes(16).toString('hex'),admin=new Pool({connectionString:source.toString()}),originalFetch=globalThis.fetch;
let pool,created=false,lose=false,fail=false,refunds=[],disputes=[],multiple=false,wrong=false,creates=0;
const records=new Map(),clientId='TEST_authored_orders',merchant='cf_'+createHash('sha256').update(clientId).digest('hex').slice(0,32);
const env={...process.env,NEEDWARE_BILLING_MODE:'cashfree_once',CASHFREE_ENVIRONMENT:'sandbox',CASHFREE_CLIENT_ID:clientId,CASHFREE_CLIENT_SECRET:'authored-fixture-secret-for-orders-only',CASHFREE_MERCHANT_ID:merchant,CASHFREE_PRO_MONTHLY_PAISE:'49900',BETTER_AUTH_URL:'http://127.0.0.1:3108',SMTP_HOST:'127.0.0.1',NEEDWARE_GENERATION_QUOTA:''};
const config=cashfreeConfig(env),price=cashfreePassPrice(config);
globalThis.fetch=async(input,options={})=>{
 const url=new URL(input);assert.equal(url.origin,'https://sandbox.cashfree.com');assert.equal(options.redirect,'error');assert.equal(options.headers['x-client-id'],clientId);
 if(fail)return Response.json({code:'internal_server_error'},{status:500});
 if(url.pathname==='/pg/orders'&&options.method==='POST'){const body=JSON.parse(options.body);assert.equal(options.headers['x-idempotency-key'].replaceAll('-',''),body.order_id.slice(3));creates++;
  if(!records.has(body.order_id))records.set(body.order_id,{...body,cf_order_id:String(100+records.size),created_at:new Date().toISOString(),order_status:'ACTIVE',payment_session_id:'session_authored_for_local_acceptance'});
  if(lose){lose=false;throw Error('Lost provider acknowledgment');}return Response.json(records.get(body.order_id));
 }
 const match=/^\/pg\/orders\/([^/]+)(.*)$/.exec(url.pathname);
 if(match){const record=records.get(match[1]);if(!record)return Response.json({code:'order_not_found'},{status:404});
  if(match[2]==='')return Response.json(wrong?{...record,order_amount:1}:record);
  if(match[2]==='/refunds')return Response.json(refunds);
  if(match[2]==='/payments'){const p={cf_payment_id:String(1000+[...records.keys()].indexOf(record.order_id)),order_id:record.order_id,payment_currency:'INR',payment_amount:499,order_currency:'INR',order_amount:499,is_captured:true,payment_status:'SUCCESS',payment_completion_time:record.paidTime};return Response.json(record.order_status==='PAID'?(multiple?[p,{...p,cf_payment_id:'9999'}]:[p]):[]);}
 }
 if(/^\/pg\/payments\/\d+\/disputes$/.test(url.pathname))return Response.json(disputes);
 throw Error('Unexpected provider request');
};
try{
 await admin.query(`CREATE DATABASE "${database}"`);created=true;source.pathname='/'+database;env.DATABASE_URL=source.toString();env.NEEDWARE_ACCEPTANCE_DATABASE=database;
 for(let i=0;i<2;i++)assert.equal(spawnSync(process.execPath,['scripts/auth-migrate.mjs'],{env,stdio:'inherit'}).status,0,'Migration and repeat migration');
 Object.assign(process.env,env);pool=new Pool({connectionString:source.toString(),max:8});
 const owner=randomUUID(),other=randomUUID();for(const user of [owner,other])await pool.query('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[user,'Orders QA',user+'@needware.invalid']);
 const id=randomUUID(),checkout=()=>cashfreeOrderCheckout(pool,owner,owner+'@needware.invalid','Orders QA','9900000000',id,price,config,env.BETTER_AUTH_URL);
 await assert.rejects(cashfreeOrderCheckout(pool,owner,owner+'@needware.invalid','Orders QA','invalid',id,price,config,env.BETTER_AUTH_URL));
 lose=true;await assert.rejects(checkout());const first=await checkout();assert.deepEqual(await checkout(),first);assert.equal(creates,1,'Lost acknowledgment resumes same order');
 await assert.rejects(cashfreeOrderCheckout(pool,other,other+'@needware.invalid','Orders QA','9900000000',id,price,config,env.BETTER_AUTH_URL),/identity/);
 await assert.rejects(cashfreeOrderCheckout(pool,owner,owner+'@needware.invalid','Orders QA','9900000000',randomUUID(),price,config,env.BETTER_AUTH_URL),/open checkout/);
 const sync=()=>synchronizeCashfreePass(pool,owner,config);await sync();assert.equal((await generationUsage(pool,owner)).plan,'free','Created order/redirect not paid evidence');
 const record=[...records.values()][0];record.order_status='PAID';record.paidTime=new Date(Date.now()+1).toISOString();await new Promise(r=>setTimeout(r,5));
 await sync();assert.equal((await generationUsage(pool,owner)).plan,'pro');const paid=(await pool.query('SELECT * FROM needware_cashfree_order WHERE id=$1',[id])).rows[0];assert.equal(new Date(paid.paid_until)-new Date(paid.paid_start),30*86400000);
 assert.equal(spawnSync(process.execPath,['scripts/auth-migrate.mjs'],{env,stdio:'inherit'}).status,0,'Migration replay preserves populated one-time billing rows');
 await sync();assert.equal(new Date((await pool.query('SELECT paid_until FROM needware_cashfree_order WHERE id=$1',[id])).rows[0].paid_until).getTime(),new Date(paid.paid_until).getTime(),'Replay never extends access');
 await assert.rejects(checkout(),/closed/);await assert.rejects(cashfreeOrderCheckout(pool,owner,owner+'@needware.invalid','Orders QA','9900000000',randomUUID(),price,config,env.BETTER_AUTH_URL),/not expired/);
 wrong=true;await assert.rejects(sync());assert.equal((await generationUsage(pool,owner)).plan,'free','Tampered order fails closed');wrong=false;await sync();
 multiple=true;await sync();assert.equal((await generationUsage(pool,owner)).plan,'free','Duplicate successful charges need refund review');multiple=false;await sync();
 const timestamp=String(Date.now()),body=Buffer.from(JSON.stringify({type:'REFUND_STATUS_WEBHOOK',event_time:new Date().toISOString(),data:{refund:{order_id:record.order_id}}}));
 const event=verifyCashfreeWebhook(config,body,timestamp,createHmac('sha256',config.secret).update(timestamp).update(body).digest('base64'));
 await enqueueCashfreeOrderEvent(pool,event,config);assert.equal((await generationUsage(pool,owner)).plan,'free','Signed notice immediately suspends stale paid authority');
 fail=true;await assert.rejects(processCashfreeOrderEvent(pool,config),/durable retry/);const retry=(await pool.query('SELECT * FROM needware_cashfree_order_event WHERE id=$1',[event.id])).rows[0];assert.equal(retry.processed_at,null);assert.equal(retry.failure,'RECONCILIATION_FAILED');fail=false;
 await pool.query('UPDATE needware_cashfree_order_event SET next_attempt_at=now() WHERE id=$1',[event.id]);await processCashfreeOrderEvent(pool,config);assert.equal((await generationUsage(pool,owner)).plan,'pro');
 await enqueueCashfreeOrderEvent(pool,event,config);assert.equal((await generationUsage(pool,owner)).plan,'pro','Processed duplicate notification does not revoke authority');
 refunds=[{order_id:record.order_id,refund_status:'PENDING'}];await sync();assert.equal((await generationUsage(pool,owner)).plan,'free');refunds=[];await sync();
 disputes=[{cf_payment_id:'1000',dispute_status:'DISPUTE_CREATED'}];await sync();assert.equal((await generationUsage(pool,owner)).plan,'free');disputes=[];await sync();
 await pool.query("UPDATE needware_entitlement SET paid_until=now()-interval '1 second' WHERE account_id=$1",[owner]);assert.equal((await generationUsage(pool,owner)).plan,'free','Expiry enforced at request time');
 await sync();await pool.query("UPDATE needware_entitlement SET updated_at=now()-interval '31 minutes' WHERE account_id=$1",[owner]);assert.equal((await generationUsage(pool,owner)).plan,'free','Stale snapshot cannot grant access');
 process.env.BETTER_AUTH_URL='https://needware.invalid';assert.equal((await generationUsage(pool,owner)).plan,'free','Sandbox cannot grant public Pro');process.env.BETTER_AUTH_URL=env.BETTER_AUTH_URL;
 await reconcileCashfreePassAccounts(pool,config);
 await pool.query('DELETE FROM auth_user WHERE id=$1',[owner]);assert.equal((await pool.query('SELECT account_id FROM needware_cashfree_order WHERE id=$1',[id])).rows[0].account_id,null,'Deleted account payment cannot attach to a new account');
 console.log('PASS one-time checkout: durable retry, ownership, exact price, no redirect grant, fixed expiry, refund/dispute revocation, webhook replay/retry, freshness, sandbox and deletion boundaries');
}finally{globalThis.fetch=originalFetch;await pool?.end();if(created){const deadline=Date.now()+5000;while((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].n){if(Date.now()>deadline)throw Error('Fixture still has open connections');await new Promise(r=>setTimeout(r,20));}await admin.query(`DROP DATABASE "${database}"`);}await admin.end();}
