import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {createWriteStream,mkdirSync} from 'node:fs';
import {loadEnvironment} from './load-environment.mjs';
loadEnvironment();mkdirSync('.logs',{recursive:true});
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const environment={...process.env,STRIPE_SECRET_KEY:`sk_test_${randomBytes(32).toString('hex')}`,STRIPE_WEBHOOK_SECRET:`whsec_${randomBytes(32).toString('hex')}`,STRIPE_PRO_PRICE_ID:'price_needwarePro',NEEDWARE_BILLING_FIXTURE:'1',NEEDWARE_BILLING_FIXTURE_PORT:String(port),NEEDWARE_BILLING_FIXTURE_TOKEN:randomBytes(32).toString('hex'),NEEDWARE_BILLING_API_URL:`http://127.0.0.1:${port}`};
environment.STRIPE_ACCOUNT_ID='acct_needwareFixture';
const server=spawn(process.execPath,['tests/fixtures/stripe-server.mjs'],{env:environment,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']}),log=createWriteStream('.logs/billing-stripe.log',{flags:'a'});server.stdout.pipe(log);server.stderr.pipe(log);const closed=new Promise(resolve=>server.once('close',resolve));
try{
  let ready=false;for(let i=0;i<60;i++){if(server.exitCode!==null)throw Error('Stripe fixture exited');try{if((await fetch(`${environment.NEEDWARE_BILLING_API_URL}/fixture/stats`,{headers:{'x-fixture-token':environment.NEEDWARE_BILLING_FIXTURE_TOKEN},signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}if(!ready)throw Error('Stripe fixture unavailable');
  const result=spawnSync(process.execPath,['scripts/run-account-acceptance.mjs','--billing'],{env:environment,stdio:'inherit'});if(result.error)throw result.error;process.exitCode=result.status??1;
}finally{const signal=name=>{try{if(process.platform==='win32')server.kill(name);else process.kill(-server.pid,name);}catch(error){if(error.code!=='ESRCH')throw error;}};signal('SIGTERM');const timer=setTimeout(()=>signal('SIGKILL'),2000);try{await closed;}finally{clearTimeout(timer);}}
