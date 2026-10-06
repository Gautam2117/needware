import {productionConfiguration} from './production-config.mjs';
import {billingEnabled} from '../apps/web/lib/billing-policy.ts';
import {workerHealthQuery} from '../apps/web/lib/worker-health-query.ts';
import {buildReady} from './build-readiness.mjs';
import {schemaReady} from './schema-readiness.mjs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPrivateKey,createPublicKey} from 'node:crypto';
export async function workersReady(client,env=process.env){
  const health=workerHealthQuery(env);
  const {rows}=await client.query(`SELECT w.worker FROM needware_worker_health w WHERE ${health.sql} GROUP BY w.worker`,health.values);
  return ['email','generation',...(billingEnabled(env)?['billing']:[])].filter(name=>!rows.some(row=>row.worker===name));
}
export function providerMatches(provider,env){
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(env.NEEDWARE_SIGNING_SEED_HEX,'hex')]),format:'der',type:'pkcs8'});
  const authority=createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('hex');
  return !provider.fixture&&provider.kind===env.NEEDWARE_PROVIDER&&provider.model===env.NEEDWARE_MODEL&&provider.signing_authority===authority
    &&provider.max_cost_microusd===Number(env.NEEDWARE_COST_CEILING_MICROUSD)
    &&provider.input_microusd_per_million===Number(env.NEEDWARE_INPUT_MICROUSD_PER_MILLION)
    &&provider.output_microusd_per_million===Number(env.NEEDWARE_OUTPUT_MICROUSD_PER_MILLION)
    &&(provider.kind!=='local'||provider.endpoint===env.NEEDWARE_LOCAL_ENDPOINT);
}
export async function providerReady(env){
  const {generationProvider}=await import('../apps/web/lib/generation-provider.ts');
  return providerMatches(await generationProvider(true),env);
}
export async function stripeReady(config,origin){
  const {billingPrice}=await import('../apps/web/lib/billing-config.ts');
  await billingPrice(config);
  const account=await config.stripe.accounts.retrieve(null);
  if(!account.charges_enabled||!account.payouts_enabled||!account.details_submitted)return false;
  const hooks=await config.stripe.webhookEndpoints.list({limit:100});
  const required=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed','invoice.voided','invoice.marked_uncollectible','customer.deleted','charge.refunded','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','radar.early_fraud_warning.created','radar.early_fraud_warning.updated'];
  // Never accept an incomplete page as proof of the installed webhook set.
  return !hooks.has_more&&hooks.data.some(hook=>hook.livemode===true&&hook.api_version==='2026-09-30.endive'&&hook.status==='enabled'&&hook.url===new URL('/api/billing/webhook',origin).href&&required.every(event=>hook.enabled_events.includes('*')||hook.enabled_events.includes(event)));
}
export async function onlineDependencies(){
  const {authResources}=await import('../apps/web/lib/auth-options.ts');
  const {pool,mail}=authResources();
  return {
    database:async()=>{
      const client=await pool.connect();
      try{await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='10s'");
        const schema=await schemaReady(client),workers=await workersReady(client,process.env);
        const operators=await client.query('SELECT count(*)::int AS count FROM auth_user WHERE id=ANY($1::uuid[]) AND "emailVerified"=true',[process.env.NEEDWARE_OPERATOR_ACCOUNTS.split(',')]);
        return {schema,workers,operators:operators.rows[0].count===process.env.NEEDWARE_OPERATOR_ACCOUNTS.split(',').length};
      }finally{try{await client.query('ROLLBACK');}finally{client.release();}}
    },
    mail:()=>mail.verify(),
    provider:()=>providerReady(process.env),
    origin:async()=>{
      const response=await fetch(process.env.BETTER_AUTH_URL,{redirect:'error',signal:AbortSignal.timeout(10000)});
      await response.body?.cancel();
      return response.status===200&&response.headers.get('content-type')?.startsWith('text/html')&&response.headers.get('x-content-type-options')==='nosniff'&&response.headers.get('referrer-policy')==='no-referrer';
    },
    stripe:async()=>{
      const {billingConfig}=await import('../apps/web/lib/billing-config.ts');
      return stripeReady(billingConfig(),process.env.BETTER_AUTH_URL);
    },
    close:async()=>{mail.close();await pool.end();}
  };
}
export async function preflight(env,{online=false,artifacts=buildReady,dependencies=onlineDependencies}={}){
  const configuration=productionConfiguration(env),checks=[{name:'configuration',status:configuration.ok?'PASS':'FAIL',issues:configuration.issues}];
  try{checks.push({name:'build',status:await artifacts()?'PASS':'FAIL',issues:[]});}catch{checks.push({name:'build',status:'FAIL',issues:['BUILD_ARTIFACTS']});}
  if(checks[1].status==='FAIL')checks[1].issues=['BUILD_ARTIFACTS'];
  if(!online||!configuration.ok){
    checks.push({name:'external',status:'UNVERIFIED',issues:[online?'CONFIGURATION_REQUIRED':'ONLINE_CHECK_REQUIRED']});
  }else{
    let probes;
    try{
      probes=await dependencies();
      try{const database=await probes.database();checks.push({name:'database',status:database.schema&&database.operators?'PASS':'FAIL',issues:[...(!database.schema?['DATABASE_SCHEMA']:[]),...(!database.operators?['OPERATOR_ACCOUNTS']:[])]});checks.push({name:'workers',status:database.workers.length?'FAIL':'PASS',issues:database.workers.map(name=>`WORKER_${name.toUpperCase()}`)});}catch{checks.push({name:'database',status:'FAIL',issues:['DATABASE_READINESS']});checks.push({name:'workers',status:'UNVERIFIED',issues:['DATABASE_REQUIRED']});}
      for(const [name,code] of [['mail','SMTP_TRANSPORT'],['provider','PROVIDER_POLICY'],...(billingEnabled(env)?[['stripe','STRIPE_ACCOUNT_PRICE_WEBHOOK']]:[]),['origin','PUBLIC_HTTPS_ORIGIN']]){
        try{checks.push({name,status:await probes[name]()?'PASS':'FAIL',issues:[]});}catch{checks.push({name,status:'FAIL',issues:[code]});}
        const check=checks.at(-1);if(check.status==='FAIL')check.issues=[code];
      }
    }catch{checks.push({name:'external',status:'FAIL',issues:['DEPENDENCY_INITIALIZATION']});}
    finally{if(probes)try{await probes.close();}catch{checks.push({name:'cleanup',status:'FAIL',issues:['CONNECTION_CLOSE']});}}
  }
  return {status:checks.every(check=>check.status==='PASS')?'PASS':checks.some(check=>check.status==='FAIL')?'FAIL':'UNVERIFIED',checks};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  // Deliberately do not load .env or .local/dev.env. Use injected production
  // secrets or Node's --env-file option. Never echo values or caught errors.
  const report=await preflight(process.env,{online:process.argv.includes('--online')});
  console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='PASS'?0:1;
}
