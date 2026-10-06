// Local compatibility only: authored HTTP fixture, no model, account, or cloud deployment.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
assert.equal(globalThis.Deno?.version.deno,'2.9.6','Run with the pinned Deno 2.9.6 runtime');
const root=process.cwd(),children=[];
await mkdir('.logs',{recursive:true});
const freePort=()=>{const listener=Deno.listen({hostname:'127.0.0.1',port:0});const port=listener.addr.port;listener.close();return port;};
const providerPort=freePort(),controlPort=freePort(),webPort=freePort();
const token=randomBytes(32).toString('hex');
// Do not inherit production keys, database credentials or automatic dotenv configuration.
const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',
  NEEDWARE_PROVIDER:'local',NEEDWARE_MODEL:'contract-fixture',NEEDWARE_LOCAL_API_KEY:'',
  NEEDWARE_LOCAL_ENDPOINT:`http://127.0.0.1:${providerPort}/v1/chat/completions`,
  NEEDWARE_FIXTURE_PORT:String(providerPort),NEEDWARE_ALLOW_LOOPBACK:'1',NEEDWARE_FIXTURE_MODE:'1',
  NEEDWARE_INPUT_MICROUSD_PER_MILLION:'0',NEEDWARE_OUTPUT_MICROUSD_PER_MILLION:'0',
  NEEDWARE_CONTROL_TOKEN:token,NEEDWARE_CONTROL_PORT:String(controlPort),
  NEEDWARE_CONTROL_URL:`http://127.0.0.1:${controlPort}`,NEEDWARE_COMPILER_FIXTURES:'1',
  NEEDWARE_PUBLIC_ORIGIN:`http://127.0.0.1:${webPort}`};
function start(name,command,args,cwd=root){
  const stream=createWriteStream(`.logs/deno-compat-${name}.log`,{flags:'w'});
  const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});
  child.closed=new Promise(resolve=>child.once('close',()=>{stream.end();resolve();}));
  child.on('error',error=>stream.write(`${error.code}\n`));
  child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});children.push(child);
}
async function ready(url){
  for(let i=0;i<100;i++){
    if(children.some(child=>child.exitCode!==null))throw Error('COMPAT_PROCESS_EXITED');
    try{if((await fetch(url,{signal:AbortSignal.timeout(500)})).ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }throw Error('COMPAT_STARTUP_TIMEOUT');
}
const run=['run','--no-config','--no-lock','--node-modules-dir=manual','-A'];
try{
  await readFile('artifacts/compiler-fixture.json');
  start('provider',Deno.execPath(),[...run,'tests/fixtures/provider-server.mjs']);
  start('control',resolve('target/release/needware-control-plane'),[]);
  await ready(`http://127.0.0.1:${providerPort}/fixture-count`);
  await ready(`${env.NEEDWARE_CONTROL_URL}/health/live`);
  const request={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'Track habits'}),signal:AbortSignal.timeout(200000)};
  assert.equal((await fetch(`${env.NEEDWARE_CONTROL_URL}/api/compile-jobs`,request)).status,401);
  const response=await fetch(`${env.NEEDWARE_CONTROL_URL}/api/compile-jobs`,{...request,headers:{...request.headers,Authorization:`Bearer ${token}`}});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/event-stream/);
  const wire=await response.text();assert.ok(wire.length<8*1024*1024);
  const events=wire.split('\n\n').flatMap(event=>event.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5))));
  const result=events.find(event=>event.kind==='package');assert.ok(result,'Native compiler must return a signed fixture package');
  const wasm=await import(pathToFileURL(resolve('apps/web/public/wasm/needware_wasm.js')).href);
  await wasm.default({module_or_path:await readFile('apps/web/public/wasm/needware_wasm_bg.wasm')});
  const bytes=Buffer.from(result.package_base64,'base64');const info=JSON.parse(wasm.inspect_package(bytes));
  assert.equal(info.signers.length,1);assert.ok(info.digest);
  const corrupted=Buffer.from(bytes);corrupted[corrupted.length-1]^=1;assert.throws(()=>wasm.inspect_package(corrupted));
  await import('../apps/web/lib/auth-options.ts');
  await import('../apps/web/lib/generation-store.ts');
  await import('../apps/web/lib/generation-provider.ts');
  start('web',Deno.execPath(),[...run,resolve('apps/web/node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(webPort)],resolve('apps/web'));
  await ready(`http://127.0.0.1:${webPort}`);
  const page=await fetch(`http://127.0.0.1:${webPort}`);assert.equal(page.status,200);assert.match(await page.text(),/Needware/);
  await writeFile('artifacts/deno-compatibility.json',JSON.stringify({version:1,runtime:Deno.version.deno,platform:Deno.build.target,status:'PASS',scope:'local authored fixture; no live model or hosted deployment',checks:['native subprocess','private gateway rejects anonymous compilation','fixture compilation','WASM package verification','tamper rejection','account and generation TypeScript module loading','Next.js production HTTP startup']},null,2)+'\n');
  console.log('PASS local Deno compatibility; cloud limits, durable workers and production acceptance remain unverified');
}finally{
  for(const child of children.reverse())if(child.exitCode===null)child.kill('SIGINT');
  const timer=setTimeout(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');},5000);
  await Promise.all(children.map(child=>child.closed));clearTimeout(timer);
}
