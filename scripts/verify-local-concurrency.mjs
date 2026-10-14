import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
// Bounded authenticated concurrency in the fixture-only database.
// This helper never runs against production or performs writes.
export async function verifyLocalConcurrency({context,origin,userId}){
 const site=new URL(origin);
 assert.equal(site.protocol,'http:');
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(site.hostname));
 const all=[];
 for(const concurrency of [1,4,8]){
  const total=concurrency*6;
  for(let start=0;start<total;start+=concurrency){
   const wave=await Promise.all(Array.from({length:concurrency},async(_,offset)=>{
    const i=start+offset,path=i%2===0?'/api/auth/get-session':'/api/vault';
    const begin=performance.now();
    try{
     const res=await context.request.get(origin+path,{timeout:15000});
     const latency=Math.round(performance.now()-begin);
     assert.equal(res.status(),200,path+' returned '+res.status());
     const body=await res.json();
     if(path.includes('get-session'))assert.equal(body?.user?.id,userId);
     else assert.ok(Object.hasOwn(body,'vault'));
     await res.dispose();
     return {path,latency,ok:true};
    }catch(error){return {path,ok:false,error:String(error).slice(0,120)}}
   }));
   all.push(...wave.map(x=>({...x,concurrency})));
  }
 }
 const good=all.filter(x=>x.ok),failed=all.filter(x=>!x.ok);
 const latencies=good.map(x=>x.latency).sort((a,b)=>a-b),pct=q=>latencies[Math.max(0,Math.ceil(q*latencies.length)-1)]??null;
 const result={status:failed.length?'FAIL':'PASS',scope:'isolated real PostgreSQL+Next.js, authenticated read load; no production calls or mutations',requests:all.length,maxConcurrency:8,errors:failed,latencyMs:{p50:pct(0.5),p95:pct(0.95),p99:pct(0.99),max:latencies.at(-1)}};
 console.log('AUTHENTICATED_LOAD '+JSON.stringify(result));
 await mkdir('artifacts',{recursive:true});
 await writeFile('artifacts/qa-auth-concurrency.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
 assert.equal(failed.length,0);
 return result;
}
