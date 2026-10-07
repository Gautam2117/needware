// Disposable PostgreSQL and local Mailpit only; exercise actual Next.js after-response dispatch.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {loadEnvironment} from './load-environment.mjs';
loadEnvironment();
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{Pool}=require('pg');
const source=new URL(process.env.DATABASE_URL);assert(['127.0.0.1','localhost'].includes(source.hostname));assert.equal(process.env.SMTP_HOST,'127.0.0.1');assert.equal(process.env.SMTP_PORT,'51025');
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const origin=`http://127.0.0.1:${port}`,database='needware_netlify_mail_'+randomBytes(12).toString('hex'),token=randomBytes(32).toString('hex'),admin=new Pool({connectionString:source.href});let pool,child,created=false;
const wait=async check=>{for(let n=0;n<100;n++){try{if(await check())return;}catch{}await new Promise(r=>setTimeout(r,200));}throw Error('Bounded mail acceptance deadline');};
try{
  await admin.query(`CREATE DATABASE "${database}"`);created=true;source.pathname='/'+database;pool=new Pool({connectionString:source.href});
  const env={...process.env,DATABASE_URL:source.href,BETTER_AUTH_URL:origin,NEEDWARE_MAIL_DISPATCH_MODE:'scheduled',NEEDWARE_MAIL_DISPATCH_TOKEN:token,NEEDWARE_BILLING_DISPATCH_MODE:'scheduled',NEEDWARE_BILLING_DISPATCH_TOKEN:token,NEEDWARE_HOSTED_GENERATION:'0',NEEDWARE_BILLING_MODE:'disabled'};
  assert.equal(spawnSync(process.execPath,['scripts/auth-migrate.mjs'],{env,stdio:'inherit'}).status,0);
  const log=createWriteStream('.logs/netlify-mail-http.log',{flags:'a'});child=spawn('pnpm',['--filter','@needware/web','start','--port',String(port)],{env,detached:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log);child.stderr.pipe(log);
  await wait(async()=>(await fetch(origin+'/account')).ok);
  const post=(path,body,authorization)=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(authorization?{authorization}: {})},body});
  assert.equal((await post('/api/internal/mail','{}')).status,401);
  assert.equal((await post('/api/internal/billing','{}')).status,401);
  assert.equal((await post('/api/internal/billing','{}','Bearer '+token.slice(0,63))).status,401);
  const billing=await post('/api/internal/billing','{}','Bearer '+token);assert.equal(billing.status,200);assert.equal((await billing.json()).status,'DISABLED');
  assert.equal((await pool.query('SELECT * FROM needware_worker_health')).rowCount,0);
  assert.equal((await post('/api/internal/mail','xxx','Bearer '+token)).status,413);
  const email=database+'@example.invalid';
  assert.equal((await post('/api/auth/sign-up/email',JSON.stringify({name:'Hosted mail acceptance fixture',email,password:randomBytes(24).toString('hex')}))).status,200);
  await wait(async()=>(await pool.query('SELECT * FROM needware_email_outbox')).rowCount===0);
  const users=await pool.query('SELECT id FROM auth_user WHERE email=$1',[email]);assert.equal(users.rowCount,1);
  await pool.query("INSERT INTO needware_email_outbox(user_id,recipient,kind,link) VALUES($1,$2,'reset',$3)",[users.rows[0].id,email,origin+'/account']);
  const dispatched=await Promise.all([post('/api/internal/mail','{}','Bearer '+token),post('/api/internal/mail','{}','Bearer '+token)]);assert(dispatched.every(r=>r.status===200));
  assert.equal((await pool.query('SELECT * FROM needware_email_outbox')).rowCount,0);
  const health=await pool.query("SELECT * FROM needware_worker_health WHERE mode='scheduled' AND period_seconds=900 AND state='idle'");assert(health.rowCount>=1);
  await wait(async()=>{const box=await(await fetch('http://127.0.0.1:58025/api/v1/search?query='+encodeURIComponent('to:'+email))).json();return box.messages?.length===2;});
  console.log('PASS actual Next.js after-response mail, protected bounded retry, concurrent lease, warm resources and scheduled health; local fixtures only');
}finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const closed=new Promise(r=>child.once('close',r));try{process.kill(-child.pid,'SIGTERM');}catch{}await closed;}
  await pool?.end();if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();
}
