// Real synthetic diagnostics. No production profile, keys or settings are changed.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {roles,verifyEndpoints,requestBudget,freeRequest,verifyResponse} from './free-model-policy.mjs';
const profile=process.argv[2]??'layered',selected=roles(profile);
assert.ok(process.argv.length<=4&&(!process.argv[3]||process.argv[3]==='--all-apps'));
const key=process.env.NEEDWARE_OPENROUTER_API_KEY;
assert.ok(key?.startsWith('sk-or-'),'Set the private OpenRouter key in the process environment');
const binary='target/release/needware-control-plane';
const binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex');
const tls=async(path,options={})=>fetch(`https://openrouter.ai/api/v1/${path}`,{...options,redirect:'error',signal:options.signal??AbortSignal.timeout(55000)});
const metadata=await tls('endpoints/zdr');assert.equal(metadata.status,200);
verifyEndpoints((await metadata.json()).data,selected);
const quota=await tls('key',{headers:{authorization:`Bearer ${key}`}});assert.equal(quota.status,200);
const quotaData=(await quota.json()).data,maxCalls=requestBudget(quotaData);
const root=`.local/free-model-results/${Date.now()}`;await mkdir(root,{recursive:true,mode:0o700});
console.log(JSON.stringify({scope:'synthetic generation diagnostics only',profile,roles:selected,maxCalls,freeQuota:quotaData.free_model_daily_requests}));
const bridgeToken=randomBytes(32).toString('hex'),calls=[],results=[];
let policyViolation=false,rateLimited=false,modelCalls=0;
const bridge=createServer(async(req,res)=>{
  try{
    if(policyViolation||rateLimited||modelCalls>=maxCalls||req.method!=='POST'||req.url!=='/v1/chat/completions'||req.headers.authorization!==`Bearer ${bridgeToken}`){res.writeHead(503);res.end('{}');return;}
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;assert.ok(size<100000);chunks.push(chunk);}
    const {role,body}=freeRequest(JSON.parse(Buffer.concat(chunks).toString()),selected);
    const callNumber=++modelCalls;
    const cancelled=new AbortController();res.once('close',()=>cancelled.abort());
    const response=await tls('chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([cancelled.signal,AbortSignal.timeout(55000)])});
    const wire=await response.text();assert.ok(wire.length<4000000);
    const parsed=JSON.parse(wire);
    try{verifyResponse(response.status,parsed);}catch{policyViolation=true;throw Error('Provider or cost receipt violated policy');}
    if(response.status===429)rateLimited=true;
    const entry={role,model:body.model,status:response.status,provider:parsed.provider??null,cost:parsed.usage?.cost??null,inputTokens:parsed.usage?.prompt_tokens??null,outputTokens:parsed.usage?.completion_tokens??null};
    calls.push(entry);console.log(JSON.stringify(entry));
    await writeFile(`${root}/call-${callNumber}.json`,JSON.stringify({request:body,response:parsed}),{mode:0o600,flag:'wx'});
    res.writeHead(response.status,{'content-type':'application/json'});res.end(wire);
  }catch{if(!res.headersSent)res.writeHead(502);res.end('{}');}
});
await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
const endpoint=`http://127.0.0.1:${bridge.address().port}/v1/chat/completions`;
const prompts=[['counter','Create a counter with a single integer count, increase and decrease buttons, and a count display. Keep data local.']];
if(process.argv.includes('--all-apps'))prompts.push(
  ['habits','Create a daily habit tracker: add habits by name, show them, mark each complete and undo completion. Keep data local.'],
  ['contacts','Create a contacts app: add a person with name and email, list contacts, and remove a selected contact. Keep data local.']);
try{
  for(const [name,prompt] of prompts){
    if(rateLimited||modelCalls>=maxCalls)break;
    const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
    const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
    const token=randomBytes(32).toString('hex');
    const child=spawn(binary,[],{env:{PATH:process.env.PATH,NODE_ENV:'production',NEEDWARE_PROVIDER:'local',NEEDWARE_MODEL:selected.generation.model,NEEDWARE_LOCAL_ENDPOINT:endpoint,NEEDWARE_LOCAL_API_KEY:bridgeToken,NEEDWARE_FIXTURE_MODE:'0',NEEDWARE_COMPILER_FIXTURES:'0',NEEDWARE_ALLOW_LOOPBACK:'1',NEEDWARE_INPUT_MICROUSD_PER_MILLION:'0',NEEDWARE_OUTPUT_MICROUSD_PER_MILLION:'0',NEEDWARE_COST_CEILING_MICROUSD:'0',NEEDWARE_CONTROL_TOKEN:token,NEEDWARE_CONTROL_PORT:String(port),NEEDWARE_SIGNING_SEED_HEX:randomBytes(32).toString('hex')},stdio:'ignore'});
    let launchError=false;
    const closed=new Promise(resolve=>{child.once('exit',resolve);child.once('error',()=>{launchError=true;resolve();});});
    try{
      const base=`http://127.0.0.1:${port}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
      let ready=false;
      for(let n=0;n<60;n++){if(launchError||child.exitCode!==null)throw Error('Diagnostic gateway exited');try{if((await fetch(base+'/api/providers',{headers,signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
      assert.ok(ready,'Diagnostic gateway startup failed');
      const started=Date.now();const response=await fetch(base+'/api/compile-jobs',{method:'POST',headers,body:JSON.stringify({prompt}),signal:AbortSignal.timeout(190000)});
      const wire=await response.text();assert.ok(wire.length<8000000);
      const events=wire.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
      const packages=events.filter(event=>event.kind==='package');
      for(const event of packages)await writeFile(`${root}/${name}.need`,Buffer.from(event.package_base64,'base64'),{mode:0o600,flag:'wx'});
      const result={name,seconds:(Date.now()-started)/1000,stages:events.filter(event=>event.kind==='stage').map(event=>({stage:event.event.stage,attempt:event.event.attempt})),errors:events.filter(event=>event.kind==='error'),packages:packages.length};
      results.push(result);console.log(JSON.stringify(result));
      assert.equal(policyViolation,false,'Benchmark routing/cost invariant failed');
    }finally{
      if(child.exitCode===null&&!launchError)child.kill('SIGINT');
      const stop=setTimeout(()=>{if(child.exitCode===null&&!launchError)child.kill('SIGKILL');},5000);
      await closed;clearTimeout(stop);
    }
  }
}finally{
  await new Promise(resolve=>bridge.close(resolve));
  await writeFile(`${root}/benchmark.json`,JSON.stringify({scope:'Real synthetic diagnostics only; no independent behavior acceptance or production integration',profile,roles:selected,binarySha256,maxCalls,policyViolation,rateLimited,results,calls}),{mode:0o600,flag:'wx'});
}
console.log('Benchmark receipt:',root+'/benchmark.json');
assert.ok(results.length>0&&results.every(result=>result.packages===1),'Generation failed: no complete set of signed packages; see private receipt');
