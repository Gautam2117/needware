import {spawn,execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {productionConfiguration} from './production-config.mjs';
import {buildReady} from './build-readiness.mjs';
const role=process.argv[2],root=process.cwd();
const commands={
  web:[process.execPath,[`${root}/apps/web/node_modules/next/dist/bin/next`,'start','--hostname','127.0.0.1','--port','3000'],`${root}/apps/web`],
  control:[`${root}/target/release/needware-control-plane`,[],root],
  email:[process.execPath,['scripts/mail-worker.mjs'],root],
  generation:[process.execPath,['scripts/generation-worker.mjs'],root],
  billing:[process.execPath,['scripts/billing-worker.mjs'],root]
};
const issues=[...productionConfiguration(process.env).issues];
if(Number(process.versions.node.split('.')[0])!==24)issues.push('NODE_24_REQUIRED');
if(!Object.hasOwn(commands,role))issues.push('SERVICE_ROLE');
if(process.env.NEEDWARE_CONTROL_URL!=='http://127.0.0.1:3001'||process.env.NEEDWARE_CONTROL_PORT&&process.env.NEEDWARE_CONTROL_PORT!=='3001')issues.push('LOOPBACK_GATEWAY_TOPOLOGY');
if(!await buildReady())issues.push('BUILD_ARTIFACTS');
try{const head=execFileSync('git',['-c',`safe.directory=${root}`,'rev-parse','HEAD'],{encoding:'utf8'}).trim();if(process.env.NEEDWARE_RELEASE_SHA!==head||execFileSync('git',['-c',`safe.directory=${root}`,'status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim())issues.push('EXACT_CLEAN_RELEASE');}catch{issues.push('EXACT_CLEAN_RELEASE');}
if(role==='control'){try{const receipt=JSON.parse(await readFile('apps/web/.next/needware-build-receipt.json','utf8'));if(!receipt.control)issues.push('CONTROL_RELEASE_BINARY');}catch{issues.push('CONTROL_RELEASE_BINARY');}}
if(issues.length){console.error(JSON.stringify({status:'FAIL',issues}));process.exitCode=1;}
else{
  const [command,args,cwd]=commands[role],child=spawn(command,args,{cwd,env:{...process.env,NEEDWARE_LOOPBACK_INGRESS:role==='web'?'1':''},stdio:'inherit',detached:process.platform!=='win32'});
  let stopping=false,timer;
  const stop=()=>{if(stopping)return;stopping=true;try{process.kill(-child.pid,'SIGINT');}catch(error){if(error.code!=='ESRCH')throw error;}timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}},20000);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  child.on('error',()=>{console.error('SERVICE_START_FAILED');process.exitCode=1;});
  child.on('close',code=>{clearTimeout(timer);process.exitCode=stopping?0:code??1;});
}
