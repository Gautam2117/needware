import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {buildReady} from './build-readiness.mjs';
import {productionConfiguration} from './production-config.mjs';
export function renderConfiguration(env){
  const issues=[];let host,alias;
  try{const origin=new URL(env.NEEDWARE_RENDER_STAGE==='preview'?env.RENDER_EXTERNAL_URL:env.BETTER_AUTH_URL);host=origin.hostname;
    if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host))issues.push('CANONICAL_HTTPS');
    alias=env.RENDER_EXTERNAL_HOSTNAME;if(!/^[a-z0-9-]+\.onrender\.com$/.test(alias??''))issues.push('RENDER_HOST');
  }catch{issues.push('CANONICAL_HTTPS');}
  if(env.RENDER!=='true'||env.NEEDWARE_RENDER_FREE!=='1')issues.push('RENDER_FREE_REQUIRED');
  if(!/^[0-9a-f]{40}$/.test(env.RENDER_GIT_COMMIT??'')||env.RENDER_GIT_COMMIT!==env.NEEDWARE_RELEASE_SHA)issues.push('RELEASE_IDENTITY');
  if(!/^[1-9][0-9]{3,4}$/.test(env.PORT??'')||Number(env.PORT)>65535||Number(env.PORT)===3000||Number(env.PORT)===3001)issues.push('PUBLIC_PORT');
  if(env.NEEDWARE_RENDER_STAGE==='preview'){
    if(env.NEEDWARE_BILLING_MODE!=='disabled'||env.NEEDWARE_HOSTED_GENERATION!=='0')issues.push('PREVIEW_PAUSED');
    for(const key of ['DATABASE_URL','BETTER_AUTH_SECRET','RESEND_API_KEY','SMTP_PASSWORD','NEEDWARE_CONTROL_TOKEN','NEEDWARE_SIGNING_SEED_HEX','NEEDWARE_BACKUP_KEY','NEEDWARE_LOCAL_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','CASHFREE_CLIENT_SECRET','STRIPE_SECRET_KEY'])if(env[key])issues.push('PREVIEW_PRIVATE_'+key);
  }else if(env.NEEDWARE_RENDER_STAGE==='production'){
    const allowed=env.NEEDWARE_HOSTED_GENERATION==='0'?['NEEDWARE_HOSTED_GENERATION']:[];
    issues.push(...productionConfiguration(env).issues.filter(code=>!allowed.includes(code)));
    if(env.NEEDWARE_MAIL_TRANSPORT!=='resend'||!/^re_[A-Za-z0-9_-]{16,256}$/.test(env.RESEND_API_KEY??''))issues.push('HTTPS_MAIL_REQUIRED');
    if(env.NEEDWARE_MAIL_DISPATCH_MODE!=='scheduled'||!/^[0-9a-f]{64}$/.test(env.NEEDWARE_MAIL_DISPATCH_TOKEN??''))issues.push('MAIL_DISPATCH_REQUIRED');
    if(env.NEEDWARE_BILLING_MODE!=='disabled'&&(env.NEEDWARE_BILLING_DISPATCH_MODE!=='scheduled'||!/^[0-9a-f]{64}$/.test(env.NEEDWARE_BILLING_DISPATCH_TOKEN??'')))issues.push('BILLING_DISPATCH_REQUIRED');
    if(env.NEEDWARE_TRUST_PROXY!=='caddy-loopback'||env.NEEDWARE_CONTROL_URL!=='http://127.0.0.1:3001'||env.NEEDWARE_CONTROL_PORT!=='3001'||env.NEEDWARE_WORKER_MODE!=='scheduled')issues.push('LOOPBACK_TOPOLOGY');
  }else issues.push('RENDER_STAGE');
  for(const key of ['NEEDWARE_FIXTURE_MODE','NEEDWARE_BILLING_FIXTURE','NEEDWARE_ALLOW_LOOPBACK'])if(env[key]&&env[key]!=='0')issues.push('FIXTURE_DISABLED');
  if(env.NODE_TLS_REJECT_UNAUTHORIZED==='0')issues.push('TLS_REQUIRED');
  if(env.NEEDWARE_EDGE_PROXY&&env.NEEDWARE_EDGE_PROXY!=='0'&&env.NEEDWARE_EDGE_PROXY!=='1')issues.push('EDGE_PROXY_MODE');
  if(env.NEEDWARE_EDGE_PROXY==='1'&&(env.NEEDWARE_RENDER_STAGE!=='production'||!/^[0-9a-f]{64}$/.test(env.NEEDWARE_EDGE_ORIGIN_PROOF??'')))issues.push('AUTHENTICATED_EDGE_REQUIRED');
  return {issues,host,alias};
}
export async function runRenderService(){
  const env=process.env,config=renderConfiguration(env),root=process.cwd();
  if(Number(process.versions.node.split('.')[0])!==24)config.issues.push('NODE_24_REQUIRED');
  if(!await buildReady())config.issues.push('BUILD_ARTIFACTS');
  try{if(execFileSync('git',['-c',`safe.directory=${root}`,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==env.NEEDWARE_RELEASE_SHA||execFileSync('git',['-c',`safe.directory=${root}`,'status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim())config.issues.push('EXACT_CLEAN_RELEASE');}catch{config.issues.push('EXACT_CLEAN_RELEASE');}
  if(config.issues.length)throw Error('RENDER_STARTUP '+config.issues.join(','));
  const runtime={...env,NEEDWARE_GENERATION_WORKER_MODE:'continuous',NEEDWARE_PUBLIC_HOST:config.host,NEEDWARE_ACCEPTED_HOSTS:[...new Set([config.host,config.alias])].join(' '),NEEDWARE_ALIAS_REDIRECT_HOST:config.host===config.alias?'never-redirect.invalid':config.alias,NEEDWARE_EDGE_ORIGIN_PROOF:env.NEEDWARE_EDGE_PROXY==='1'?env.NEEDWARE_EDGE_ORIGIN_PROOF:randomBytes(32).toString('hex'),NEEDWARE_LOOPBACK_INGRESS:'1'};
  const children=[];let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;for(const child of children)try{process.kill(-child.pid,'SIGTERM');}catch{};const timer=setTimeout(()=>{for(const child of children)try{process.kill(-child.pid,'SIGKILL');}catch{}},20000);timer.unref();};
  const start=(name,command,args,options={})=>{const child=spawn(command,args,{cwd:root,env:runtime,stdio:'inherit',detached:true,...options});children.push(child);
    child.on('error',()=>{console.error('RENDER_CHILD_START_FAILED',name);process.exitCode=1;stop();});child.on('close',code=>{if(!stopping){console.error('RENDER_CHILD_EXIT',name,code);process.exitCode=1;stop();}});return child;};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  start('web',process.execPath,[`${root}/apps/web/node_modules/next/dist/bin/next`,'start','--hostname','127.0.0.1','--port','3000'],{cwd:root+'/apps/web',env:{...runtime,NODE_OPTIONS:'--max-old-space-size=192'}});
  start('ingress','caddy',['run','--config',root+'/infra/render/Caddyfile','--adapter','caddyfile']);
  if(env.NEEDWARE_HOSTED_GENERATION==='1'){start('control',root+'/target/release/needware-control-plane',[]);start('generation',process.execPath,['scripts/generation-worker.mjs'],{env:{...runtime,NODE_OPTIONS:'--max-old-space-size=96'}});}
  const targets=env.NEEDWARE_RENDER_STAGE==='production'?[['mail',env.NEEDWARE_MAIL_DISPATCH_TOKEN,15000],...(env.NEEDWARE_BILLING_MODE==='disabled'?[]:[['billing',env.NEEDWARE_BILLING_DISPATCH_TOKEN,300000]])]:[];
  const next=new Map();while(!stopping){for(const [name,token,interval] of targets){if((next.get(name)??0)>Date.now())continue;next.set(name,Date.now()+interval);
    try{const response=await fetch('http://127.0.0.1:3000/api/internal/'+name,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(25000)});await response.body?.cancel();if(!response.ok)console.error('RENDER_BOUNDED_RETRY',name,response.status);}catch{console.error('RENDER_BOUNDED_RETRY',name,'unavailable');}}
    await delay(1000);
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)runRenderService().catch(error=>{console.error(error.message?.startsWith('RENDER_STARTUP ')?error.message:'RENDER_STARTUP_FAILED');process.exitCode=1;});
