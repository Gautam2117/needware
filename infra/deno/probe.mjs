// No public compilation route: one bounded startup fixture, then sanitized health only.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const receipt=JSON.parse(await readFile('probe-receipt.json','utf8'));
const children=[];
const start=Date.now();
let result={status:'FAIL',scope:receipt.scope,release:receipt.release};
let phase='artifact verification';
const port=()=>{const socket=Deno.listen({hostname:'127.0.0.1',port:0});const number=socket.addr.port;socket.close();return number;};
const providerPort=port(),controlPort=port(),token=randomBytes(32).toString('hex');
// Deliberately exclude all inherited secrets. Fixture-mode signing is ephemeral.
const env={NODE_ENV:'production',NEEDWARE_PROVIDER:'local',NEEDWARE_MODEL:'contract-fixture',
  NEEDWARE_LOCAL_ENDPOINT:`http://127.0.0.1:${providerPort}/v1/chat/completions`,
  NEEDWARE_FIXTURE_PORT:String(providerPort),NEEDWARE_ALLOW_LOOPBACK:'1',
  NEEDWARE_FIXTURE_MODE:'1',NEEDWARE_COMPILER_FIXTURES:'1',
  NEEDWARE_INPUT_MICROUSD_PER_MILLION:'0',NEEDWARE_OUTPUT_MICROUSD_PER_MILLION:'0',
  NEEDWARE_CONTROL_PORT:String(controlPort),NEEDWARE_CONTROL_TOKEN:token};
function launch(command,args){
  const child=new Deno.Command(command,{args,env,clearEnv:true,stdout:'null',stderr:'null'}).spawn();
  children.push(child);return child;
}
async function ready(url){
  for(let i=0;i<50;i++){
    try{if((await fetch(url,{signal:AbortSignal.timeout(250)})).ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }throw Error('STARTUP_TIMEOUT');
}
try{
  assert.equal(receipt.version,1);
  assert.match(receipt.release,/^[0-9a-f]{40}$/);
  if(!Deno.args.includes('--check')||Deno.args.includes('--require-release')){
    assert.equal(receipt.sourceClean,true);assert.equal(receipt.platform,'linux');assert.equal(receipt.arch,'x64');
  }
  const allowed=['probe.mjs','needware-control-plane','tests/fixtures/provider-server.mjs','artifacts/compiler-fixture.json','wasm/needware_wasm.js','wasm/needware_wasm_bg.wasm'];
  assert.deepEqual(receipt.files.map(file=>file.name).sort(),allowed.sort());
  for(const file of receipt.files)assert.equal(createHash('sha256').update(await readFile(file.name)).digest('hex'),file.sha256);
  phase='subprocess startup';
  launch(Deno.execPath(),['run','--no-config','--no-lock','--allow-net=127.0.0.1','--allow-read=artifacts/compiler-fixture.json','--allow-env=NEEDWARE_FIXTURE_PORT,NEEDWARE_FIXTURE_DELAY_MS','tests/fixtures/provider-server.mjs']);
  launch(`${Deno.cwd()}/needware-control-plane`,[]);
  await ready(`http://127.0.0.1:${providerPort}/fixture-count`);
  await ready(`http://127.0.0.1:${controlPort}/health/live`);
  phase='private fixture compilation';
  const endpoint=`http://127.0.0.1:${controlPort}/api/compile-jobs`;
  const request={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'Track habits'}),signal:AbortSignal.timeout(15000)};
  assert.equal((await fetch(endpoint,request)).status,401);
  const response=await fetch(endpoint,{...request,headers:{...request.headers,Authorization:`Bearer ${token}`}});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/^text\/event-stream/);
  const wire=await response.text();assert.ok(wire.length<8*1024*1024);
  const events=wire.split('\n\n').flatMap(event=>event.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5))));
  const compiled=events.find(event=>event.kind==='package');assert.ok(compiled);
  phase='WASM package verification';
  const wasm=await import('./wasm/needware_wasm.js');
  await wasm.default({module_or_path:await readFile('wasm/needware_wasm_bg.wasm')});
  const bytes=Buffer.from(compiled.package_base64,'base64');
  const info=JSON.parse(wasm.inspect_package(bytes));assert.equal(info.signers.length,1);assert.ok(info.digest);
  bytes[bytes.length-1]^=1;assert.throws(()=>wasm.inspect_package(bytes));
  result={...result,status:'PASS',runtime:Deno.version.deno,platform:Deno.build.target,sourceClean:receipt.sourceClean,
    durationMs:Date.now()-start,checks:['artifact hashes','native subprocess','private gateway 401','fixture compile SSE','signed package WASM validation','tamper rejection']};
}catch{
  // Do not expose child logs, tokens, packages, environment or exception details.
  result={...result,phase,durationMs:Date.now()-start};
}finally{
  for(const child of children)try{child.kill('SIGTERM');}catch{}
  const kill=setTimeout(()=>{for(const child of children)try{child.kill('SIGKILL');}catch{}},1000);
  await Promise.allSettled(children.map(child=>child.status));clearTimeout(kill);
}
if(Deno.args.includes('--check')){console.log(JSON.stringify(result));Deno.exit(result.status==='PASS'?0:1);}
Deno.serve({port:Number(Deno.env.get('PORT')??8000)},request=>{
  if(request.method!=='GET'||new URL(request.url).pathname!=='/health')return new Response('Not found',{status:404});
  return Response.json(result,{status:result.status==='PASS'?200:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
});
