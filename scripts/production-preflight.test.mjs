import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createPrivateKey,createPublicKey} from 'node:crypto';
import {productionConfiguration} from './production-config.mjs';
import {preflight,workersReady,providerMatches,stripeReady} from './production-preflight.mjs';
const secret=()=>randomBytes(32).toString('hex');
export function configured(){return {NODE_ENV:'production',BETTER_AUTH_URL:'https://needware.continuumarc.tech',DATABASE_URL:'postgres://user:password@db.continuumarc.tech/needware',NEEDWARE_DATABASE_CA_PEM:'configured CA',BETTER_AUTH_SECRET:secret(),SMTP_HOST:'smtp.continuumarc.tech',SMTP_PORT:'587',SMTP_USER:'user',SMTP_PASSWORD:secret(),NEEDWARE_MAIL_FROM:'no-reply@continuumarc.tech',NEEDWARE_HOSTED_GENERATION:'1',NEEDWARE_CONTROL_TOKEN:secret(),NEEDWARE_CONTROL_URL:'http://127.0.0.1:3001',NEEDWARE_SIGNING_SEED_HEX:secret(),NEEDWARE_BACKUP_KEY:secret(),NEEDWARE_PROVIDER:'open_ai',OPENAI_API_KEY:secret(),NEEDWARE_MODEL:'configured-model',NEEDWARE_INPUT_MICROUSD_PER_MILLION:'100',NEEDWARE_OUTPUT_MICROUSD_PER_MILLION:'200',NEEDWARE_COST_CEILING_MICROUSD:'500000',STRIPE_SECRET_KEY:'sk_live_'+secret(),STRIPE_WEBHOOK_SECRET:'whsec_'+secret(),STRIPE_PRO_PRICE_ID:'price_approved',STRIPE_ACCOUNT_ID:'acct_approved',NEEDWARE_OPERATOR_ACCOUNTS:'00000000-0000-4000-8000-000000000001'};}
test('production configuration rejects fixture, transport and authority hazards',()=>{
  const env=configured();assert.equal(productionConfiguration(env).ok,true);
  for(const [key,value] of [['BETTER_AUTH_URL','http://127.0.0.1:3000'],['BETTER_AUTH_URL','https://needware.example'],['DATABASE_URL','postgres://user:password@db.continuumarc.tech/needware?sslmode=no-verify'],['DATABASE_URL','postgres://user:password@db.continuumarc.tech/needware_acceptance_deadbeef'],['NEEDWARE_DATABASE_CA_PEM',''],['SMTP_HOST','127.0.0.1'],['SMTP_PORT','51025'],['SMTP_PASSWORD',''],['NODE_TLS_REJECT_UNAUTHORIZED','0'],['NEEDWARE_FIXTURE_MODE','1'],['NEEDWARE_BILLING_FIXTURE','1'],['NEEDWARE_ALLOW_LOOPBACK','1'],['NEEDWARE_ACCEPTANCE_DATABASE','fixture'],['NEEDWARE_BILLING_API_URL','http://127.0.0.1:3030'],['STRIPE_SECRET_KEY','sk_test_'+secret()],['NEEDWARE_CONTROL_URL','http://gateway.continuumarc.tech'],['NEEDWARE_SIGNING_SEED_HEX','0'.repeat(64)],['NEEDWARE_BACKUP_KEY',env.NEEDWARE_SIGNING_SEED_HEX],['NEEDWARE_PROVIDER','unknown'],['NEEDWARE_COST_CEILING_MICROUSD','1000000001'],['NEEDWARE_OPERATOR_ACCOUNTS','']])assert.equal(productionConfiguration({...env,[key]:value}).ok,false,key);
});
test('invalid configuration never initializes external probes or leaks values',async()=>{
  let called=false;const env={BETTER_AUTH_SECRET:secret(),DATABASE_URL:'SECRET_INVALID_URL'};
  const result=await preflight(env,{online:true,artifacts:async()=>true,dependencies:async()=>{called=true;throw Error('secret');}});
  assert.equal(called,false);assert.equal(result.status,'FAIL');assert(!JSON.stringify(result).includes(env.BETTER_AUTH_SECRET));assert(!JSON.stringify(result).includes(env.DATABASE_URL));
});
test('offline checks never imply production acceptance',async()=>{
  const result=await preflight(configured(),{artifacts:async()=>true,dependencies:()=>{throw Error('unexpected');}});
  assert.equal(result.status,'UNVERIFIED');assert.equal(result.checks.at(-1).status,'UNVERIFIED');
});
test('independent external failures remain redacted and connections close',async()=>{
  let closed=false;const result=await preflight(configured(),{online:true,artifacts:async()=>true,dependencies:async()=>({database:async()=>({schema:false,operators:false,workers:['generation']}),mail:async()=>{throw Error('smtp-password');},provider:async()=>false,stripe:async()=>{throw Error('stripe-key');},origin:async()=>false,close:async()=>{closed=true;}})});
  assert.equal(closed,true);assert.equal(result.status,'FAIL');assert.equal(result.checks.filter(x=>x.status==='FAIL').length,6);assert(!JSON.stringify(result).includes('smtp-password'));assert(!JSON.stringify(result).includes('stripe-key'));
});
test('all online gates and build integrity are required',async()=>{
  const options={online:true,artifacts:async()=>true,dependencies:async()=>({database:async()=>({schema:true,operators:true,workers:[]}),mail:async()=>true,provider:async()=>true,stripe:async()=>true,origin:async()=>true,close:async()=>{}})};
  assert.equal((await preflight(configured(),options)).status,'PASS');
  assert.equal((await preflight(configured(),{...options,artifacts:async()=>false})).status,'FAIL');
});
test('worker readiness requires each durable worker',async()=>{
  assert.deepEqual(await workersReady({query:async()=>({rows:[{worker:'email'},{worker:'billing'}]})}),['generation']);
});
test('gateway must match the installation signer and approved cost policy',()=>{
  const env=configured(),key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(env.NEEDWARE_SIGNING_SEED_HEX,'hex')]),format:'der',type:'pkcs8'});
  const provider={kind:env.NEEDWARE_PROVIDER,model:env.NEEDWARE_MODEL,signing_authority:createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('hex'),max_cost_microusd:500000,input_microusd_per_million:100,output_microusd_per_million:200};
  assert.equal(providerMatches(provider,env),true);
  for(const [key,value] of [['signing_authority',secret()],['model','other'],['max_cost_microusd',1],['input_microusd_per_million',0],['kind','local']])assert.equal(providerMatches({...provider,[key]:value},env),false,key);
});
test('Stripe binding rejects foreign accounts, unsuitable prices and incomplete webhook policy',async()=>{
  const env=configured(),account={id:env.STRIPE_ACCOUNT_ID,charges_enabled:true,payouts_enabled:true,details_submitted:true};
  const price={id:env.STRIPE_PRO_PRICE_ID,active:true,livemode:true,type:'recurring',recurring:{interval:'month',interval_count:1},billing_scheme:'per_unit',unit_amount:100,currency:'usd'};
  const hook={url:new URL('/api/billing/webhook',env.BETTER_AUTH_URL).href,status:'enabled',livemode:true,api_version:'2026-09-30.endive',enabled_events:['*']};
  const config={price:env.STRIPE_PRO_PRICE_ID,account:env.STRIPE_ACCOUNT_ID,live:true,stripe:{accounts:{retrieve:async()=>account},prices:{retrieve:async()=>price},webhookEndpoints:{list:async()=>({has_more:false,data:[hook]})}}};
  assert.equal(await stripeReady(config,env.BETTER_AUTH_URL),true);
  account.id='acct_foreign';await assert.rejects(()=>stripeReady(config,env.BETTER_AUTH_URL),/does not match/);account.id=env.STRIPE_ACCOUNT_ID;
  for(const [key,value] of [['active',false],['livemode',false],['unit_amount',0],['currency','unknown']]){const original=price[key];price[key]=value;await assert.rejects(()=>stripeReady(config,env.BETTER_AUTH_URL),/monthly Pro price/);price[key]=original;}
  for(const [key,value] of [['status','disabled'],['livemode',false],['api_version','other'],['url','https://foreign.continuumarc.tech/api/billing/webhook'],['enabled_events',['invoice.paid']]]){const original=hook[key];hook[key]=value;assert.equal(await stripeReady(config,env.BETTER_AUTH_URL),false);hook[key]=original;}
});
