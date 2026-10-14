// Bounded, read-only production smoke: no inference, login, order, or mutation.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
const release=process.argv[2];
assert.match(release??'',/^[0-9a-f]{40}$/,'Pass the exact expected live release SHA');
const origin='https://needware.continuumarc.tech';
const failures=[],samples=[],routes={};
async function probe(path,expected,timeout=30000){
 const start=performance.now();
 try{
  const response=await fetch(origin+path,{redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(timeout)});
  const elapsed=Math.round(performance.now()-start);
  if(response.status!==expected)throw Error('HTTP '+response.status+', expected '+expected);
  if(path==='/api/health'){
   const body=await response.json();
   assert.equal(body.status,'available');assert.equal(body.release,release);assert.equal(body.hostedGeneration,true);
   assert.ok(['disabled','cashfree_once'].includes(body.billing));
   return {code:response.status,elapsedMs:elapsed,release:body.release,billing:body.billing};
  }
  await response.body?.cancel();
  return {code:response.status,elapsedMs:elapsed};
 }catch(e){const failure={path,reason:String(e).slice(0,230)};failures.push(failure);return {error:failure.reason}}
}
for(const [path,status] of [['/api/health',200],['/',200],['/pricing',200],['/billing',200],['/refunds',200],['/privacy',200],['/terms',200],['/api/billing',401],['/api/generation/jobs',401]]){
 routes[path]=await probe(path,status);
}
for(let batch=0;batch<6;batch++){
 const pair=await Promise.all([probe('/api/health',200),probe('/api/health',200)]);
 samples.push(...pair.map(x=>x.elapsedMs).filter(Number.isFinite));
}
samples.sort((a,b)=>a-b);
const pct=q=>samples[Math.min(samples.length-1,Math.ceil(samples.length*q)-1)]??null;
const receipt={checkedAt:new Date().toISOString(),scope:'read-only production smoke; 12 health requests with concurrency 2; not customer load proof',origin,expectedRelease:release,requestCount:21,healthConcurrency:2,latencyMs:{median:pct(.5),p95:pct(.95),max:samples.at(-1)??null},routes,failures,financialTransactions:0,modelRequests:0,status:failures.length?'FAIL':'PASS'};
console.log(JSON.stringify(receipt,null,2));if(failures.length)process.exitCode=1;
