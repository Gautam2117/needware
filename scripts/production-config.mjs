// Pure, redacted deployment checks. No environment loading, network calls or writes.
import {isIP} from 'node:net';
import {billingEnabled} from '../apps/web/lib/billing-policy.ts';
import {globalGenerationPolicy} from '../apps/web/lib/generation-global-quota.ts';
const loopback=host=>['localhost','127.0.0.1','[::1]'].includes(host);
const publicHost=host=>!isIP(host)&&!loopback(host)&&host.includes('.')&&!/(?:^|\.)(?:localhost|invalid|example|test|local)$/.test(host);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function productionConfiguration(env){
  const issues=[],check=(condition,code)=>{if(!condition)issues.push(code);};
  const url=(name)=>{try{return new URL(env[name]);}catch{return undefined;}};
  const origin=url('BETTER_AUTH_URL'),database=url('DATABASE_URL'),control=url('NEEDWARE_CONTROL_URL');
  check(env.NODE_ENV==='production','NODE_ENV');
  check(origin?.protocol==='https:'&&publicHost(origin.hostname)&&origin.pathname==='/'&&!origin.search&&!origin.hash&&!origin.username&&!origin.password,'BETTER_AUTH_URL');
  check(database&&['postgres:','postgresql:'].includes(database.protocol)&&database.hostname&&database.username&&database.password&&/^\/[A-Za-z][A-Za-z0-9_]{0,62}$/.test(database.pathname)&&!database.pathname.startsWith('/needware_acceptance_')&&!database.hash,'DATABASE_URL');
  if(database){
    check([...database.searchParams.keys()].every(key=>key==='sslmode')&&(!database.searchParams.has('sslmode')||database.searchParams.get('sslmode')==='verify-full'),'DATABASE_TLS_OPTIONS');
    if(!loopback(database.hostname))check(Boolean(env.NEEDWARE_DATABASE_CA_PEM)&&env.NEEDWARE_DATABASE_CA_PEM.length<=65536,'NEEDWARE_DATABASE_CA_PEM');
  }
  check(typeof env.BETTER_AUTH_SECRET==='string'&&env.BETTER_AUTH_SECRET.length>=32&&env.BETTER_AUTH_SECRET.length<=4096,'BETTER_AUTH_SECRET');
  check(typeof env.SMTP_HOST==='string'&&publicHost(env.SMTP_HOST)&&!/[\s/:]/.test(env.SMTP_HOST),'SMTP_HOST');
  check(['465','587'].includes(env.SMTP_PORT),'SMTP_PORT');
  check(Boolean(env.SMTP_USER)&&Boolean(env.SMTP_PASSWORD),'SMTP_CREDENTIALS');
  check(typeof env.NEEDWARE_MAIL_FROM==='string'&&env.NEEDWARE_MAIL_FROM.length<=254&&/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(env.NEEDWARE_MAIL_FROM),'NEEDWARE_MAIL_FROM');
  check(env.NODE_TLS_REJECT_UNAUTHORIZED!=='0','NODE_TLS_REJECT_UNAUTHORIZED');
  for(const key of ['NEEDWARE_FIXTURE_MODE','NEEDWARE_BILLING_FIXTURE','NEEDWARE_ALLOW_LOOPBACK'])check(!env[key]||env[key]==='0',key);
  for(const key of ['NEEDWARE_BILLING_API_URL','NEEDWARE_ACCEPTANCE_DATABASE'])check(!env[key],key);
  check(!env.NEEDWARE_TRUST_PROXY||['vercel','caddy-loopback'].includes(env.NEEDWARE_TRUST_PROXY),'NEEDWARE_TRUST_PROXY');
  check(env.NEEDWARE_HOSTED_GENERATION==='1','NEEDWARE_HOSTED_GENERATION');
  check(['continuous','scheduled'].includes(env.NEEDWARE_WORKER_MODE??'continuous'),'NEEDWARE_WORKER_MODE');
  const period=Number(env.NEEDWARE_WORKER_INTERVAL_SECONDS??'300');
  check(Number.isInteger(period)&&period>=60&&period<=3600,'NEEDWARE_WORKER_INTERVAL_SECONDS');
  if(env.NEEDWARE_WORKER_MODE==='scheduled')check(!billingEnabled(env),'SCHEDULED_BILLING');
  check(['wire','canonical'].includes(env.NEEDWARE_APPLICATION_FORMAT??'wire'),'NEEDWARE_APPLICATION_FORMAT');
  if(env.NEEDWARE_APPLICATION_FORMAT==='canonical')check(env.NEEDWARE_PROVIDER==='local','CANONICAL_PROVIDER');
  check(/^[A-Za-z0-9]{32,128}$/.test(env.NEEDWARE_CONTROL_TOKEN??''),'NEEDWARE_CONTROL_TOKEN');
  check(control&&((control.protocol==='http:'&&control.hostname==='127.0.0.1')||(control.protocol==='https:'&&publicHost(control.hostname)))&&control.pathname==='/'&&!control.search&&!control.hash&&!control.username&&!control.password,'NEEDWARE_CONTROL_URL');
  for(const key of ['NEEDWARE_SIGNING_SEED_HEX','NEEDWARE_BACKUP_KEY'])check(/^[0-9a-fA-F]{64}$/.test(env[key]??'')&&!/^([0-9a-fA-F])\1+$/.test(env[key]),key);
  const secrets=[env.BETTER_AUTH_SECRET,env.NEEDWARE_CONTROL_TOKEN,env.NEEDWARE_SIGNING_SEED_HEX?.toLowerCase(),env.NEEDWARE_BACKUP_KEY?.toLowerCase()].filter(Boolean);
  check(new Set(secrets).size===secrets.length,'INDEPENDENT_INSTALLATION_SECRETS');
  const providers={open_ai:'OPENAI_API_KEY',anthropic:'ANTHROPIC_API_KEY',gemini:'GEMINI_API_KEY',local:'NEEDWARE_LOCAL_API_KEY'},credential=Object.hasOwn(providers,env.NEEDWARE_PROVIDER)?providers[env.NEEDWARE_PROVIDER]:undefined;
  check(Boolean(credential),'NEEDWARE_PROVIDER');
  if(credential)check(typeof env[credential]==='string'&&env[credential].length>=16&&env[credential].length<=4096&&!/\s/.test(env[credential]),credential);
  check(typeof env.NEEDWARE_MODEL==='string'&&env.NEEDWARE_MODEL.length>0&&env.NEEDWARE_MODEL.length<=200&&!/[\r\n]/.test(env.NEEDWARE_MODEL),'NEEDWARE_MODEL');
  if(env.NEEDWARE_PROVIDER==='local'){const endpoint=url('NEEDWARE_LOCAL_ENDPOINT');check(endpoint?.protocol==='https:'&&publicHost(endpoint.hostname)&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'NEEDWARE_LOCAL_ENDPOINT');}
  for(const key of ['NEEDWARE_INPUT_MICROUSD_PER_MILLION','NEEDWARE_OUTPUT_MICROUSD_PER_MILLION','NEEDWARE_COST_CEILING_MICROUSD'])check(/^(0|[1-9][0-9]*)$/.test(env[key]??'')&&Number.isSafeInteger(Number(env[key]))&&Number(env[key])<=(key==='NEEDWARE_COST_CEILING_MICROUSD'?1000000000:1000000000000),key);
  check(['disabled','stripe'].includes(env.NEEDWARE_BILLING_MODE??'stripe'),'NEEDWARE_BILLING_MODE');
  if(billingEnabled(env)){
    check(/^sk_live_[A-Za-z0-9]{24,}$/.test(env.STRIPE_SECRET_KEY??''),'STRIPE_SECRET_KEY');
    check(/^whsec_[A-Za-z0-9]{24,}$/.test(env.STRIPE_WEBHOOK_SECRET??''),'STRIPE_WEBHOOK_SECRET');
    check(/^price_[A-Za-z0-9]+$/.test(env.STRIPE_PRO_PRICE_ID??''),'STRIPE_PRO_PRICE_ID');
    check(/^acct_[A-Za-z0-9]+$/.test(env.STRIPE_ACCOUNT_ID??''),'STRIPE_ACCOUNT_ID');
  }else{
    for(const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRO_PRICE_ID','STRIPE_ACCOUNT_ID'])check(!env[key],'DISABLED_BILLING_'+key);
    let quota;try{quota=globalGenerationPolicy(env);}catch{}
    check(Boolean(quota)&&env.NEEDWARE_GENERATION_MAX_TOKENS!==undefined&&quota.neurons<=quota.daily&&quota.neurons<=quota.accountDaily,'GLOBAL_GENERATION_POLICY');
    check(env.NEEDWARE_PROVIDER==='local'&&env.NEEDWARE_MODEL==='@cf/openai/gpt-oss-120b'&&/^[0-9a-f]{32}$/.test(env.NEEDWARE_CLOUDFLARE_ACCOUNT_ID??''),'FREE_GENERATION_PROVIDER');
    check(env.NEEDWARE_APPLICATION_FORMAT==='canonical','FREE_GENERATION_FORMAT');
    check(env.NEEDWARE_LOCAL_ENDPOINT===`https://api.cloudflare.com/client/v4/accounts/${env.NEEDWARE_CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,'FREE_GENERATION_ENDPOINT');
    check(['NEEDWARE_INPUT_MICROUSD_PER_MILLION','NEEDWARE_OUTPUT_MICROUSD_PER_MILLION','NEEDWARE_COST_CEILING_MICROUSD'].every(key=>env[key]==='0'),'FREE_GENERATION_NO_PAID_FALLBACK');
  }
  const operators=env.NEEDWARE_OPERATOR_ACCOUNTS?.split(',')??[];
  check(operators.length>0&&operators.length<=16&&operators.every(value=>uuid.test(value))&&new Set(operators).size===operators.length,'NEEDWARE_OPERATOR_ACCOUNTS');
  return {ok:issues.length===0,issues};
}
