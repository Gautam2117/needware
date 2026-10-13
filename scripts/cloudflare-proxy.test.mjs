import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{proxyRequest,keepWarm} from '../infra/cloudflare/needware-proxy.mjs';
const env={NEEDWARE_CANONICAL_HOST:'needware.continuumarc.tech',NEEDWARE_RENDER_ORIGIN:'https://needware-test.onrender.com',NEEDWARE_EDGE_ORIGIN_PROOF:'a'.repeat(64),NEEDWARE_STAGING_HOST:'needware-test.govindgautam933.workers.dev'};
test('hashed public assets survive an origin outage without caching authenticated pages or errors',async()=>{
 const entries=new Map(),cache={match:async key=>entries.get(key.url)?.clone(),put:async(key,value)=>{entries.set(key.url,value);}};
 let calls=0;const origin=async request=>{calls++;assert.equal(request.headers.get('cookie'),null);assert.equal(request.headers.get('authorization'),null);return new Response('asset',{headers:{'Content-Type':'application/javascript'}});};
 const asset=new Request('https://needware.continuumarc.tech/_next/static/chunks/abc123.js',{headers:{cookie:'private',authorization:'Bearer private'}});
 const first=await proxyRequest(asset,env,origin,cache);assert.match(first.headers.get('cache-control'),/immutable/);assert.equal(await first.text(),'asset');
 const second=await proxyRequest(asset,env,async()=>{throw Error('offline');},cache);assert.equal(await second.text(),'asset');assert.equal(calls,1);
 for(const path of ['/account','/api/documents','/frame.js','/_next/static/chunks/unexpected.js']){
  const response=await proxyRequest(new Request('https://needware.continuumarc.tech'+path),env,async()=>new Response('private html',{headers:{'Content-Type':'text/html','Set-Cookie':'private'}}),cache);
  assert.equal(response.headers.get('cache-control'),'no-store');
 }
 assert.equal(entries.size,1);
 const failure=await proxyRequest(new Request('https://needware.continuumarc.tech/_next/static/chunks/error.js'),env,async()=>new Response('error',{status:503,headers:{'Content-Type':'application/javascript'}}),cache);
 assert.equal(failure.status,503);assert.equal(entries.size,1);
});
test('keep-warm only dispatches an enabled bounded health check to the fixed origin',async()=>{
  let calls=0;
  const upstream=async(url,options)=>{calls++;assert.equal(url,'https://needware-free.onrender.com/api/health');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.signal);assert.equal(options.headers,undefined);return new Response('healthy');};
  assert.equal(await keepWarm(env,upstream),false);
  assert.equal(await keepWarm({...env,NEEDWARE_KEEP_WARM:'1'},upstream),false);
  assert.equal(await keepWarm({...env,NEEDWARE_KEEP_WARM:'1',NEEDWARE_RENDER_ORIGIN:'https://needware-free.onrender.com'},upstream),true);
  assert.equal(calls,1);
  assert.equal(await keepWarm({...env,NEEDWARE_KEEP_WARM:'1',NEEDWARE_RENDER_ORIGIN:'https://needware-free.onrender.com'},async()=>{throw Error('outage');}),false);
});
test('raw signed bodies, query bytes, cookies and provider headers pass without redirect following',async()=>{
  const body='{ "signed": "exact bytes" }',headers={host:'needware.continuumarc.tech',cookie:'session=private','content-type':'application/json','x-webhook-signature':'signed','cf-connecting-ip':'2001:db8::1','x-needware-edge-ip':'8.8.8.8','x-needware-origin-proof':'forged','x-forwarded-for':'1.1.1.1','x-needware-auth-ip':'bad'};
  const upstream=async(request,options)=>{assert.equal(request.url,'https://needware-test.onrender.com/api/billing/webhook?cursor=a%2Bb');assert.equal(await request.text(),body);assert.equal(options.redirect,'manual');assert.equal(request.headers.get('cookie'),'session=private');assert.equal(request.headers.get('x-webhook-signature'),'signed');assert.equal(request.headers.get('x-needware-origin-proof'),env.NEEDWARE_EDGE_ORIGIN_PROOF);assert.equal(request.headers.get('x-needware-edge-ip'),'2001:db8::1');assert.equal(request.headers.get('x-forwarded-for'),null);assert.equal(request.headers.get('x-needware-auth-ip'),null);return new Response('redirect',{status:302,headers:{Location:'https://attacker.example.org'}});};
  const response=await proxyRequest(new Request('https://needware.continuumarc.tech/api/billing/webhook?cursor=a%2Bb',{method:'POST',body,headers}),env,upstream);assert.equal(response.status,302);
});
test('alternate host is public-only and removes credentials',async()=>{
  let calls=0;const upstream=async request=>{calls++;assert.equal(request.headers.get('cookie'),null);assert.equal(request.headers.get('authorization'),null);return new Response('public');};
  const host='https://'+env.NEEDWARE_STAGING_HOST;
  assert.equal((await proxyRequest(new Request(host+'/pricing',{headers:{cookie:'private',authorization:'Bearer secret'}}),env,upstream)).status,200);
  for(const request of [new Request(host+'/api/auth/get-session'),new Request(host+'/api/billing'),new Request(host+'/account',{method:'POST',body:'private'}),new Request('https://unexpected.example.org/pricing')])assert.equal((await proxyRequest(request,env,upstream)).status,421);
  assert.equal(calls,1);
});
test('invalid destination, proof or canonical configuration stays closed before dispatch',async()=>{
  let calls=0;const upstream=async()=>{calls++;return new Response('should not dispatch');};
  for(const settings of [{NEEDWARE_RENDER_ORIGIN:'http://needware-test.onrender.com'},{NEEDWARE_RENDER_ORIGIN:'https://attacker.example.org'},{NEEDWARE_RENDER_ORIGIN:'https://user:password@needware-test.onrender.com'},{NEEDWARE_RENDER_ORIGIN:'https://needware-test.onrender.com/private'},{NEEDWARE_EDGE_ORIGIN_PROOF:''},{NEEDWARE_CANONICAL_HOST:'attacker.example.org'}])assert.equal((await proxyRequest(new Request('https://needware.continuumarc.tech/'),{...env,...settings},upstream)).status,503);
  assert.equal(calls,0);
});
test('an origin outage returns no exception or private values',async()=>{
  const response=await proxyRequest(new Request('https://needware.continuumarc.tech/'),env,async()=>{throw Error('private provider detail');});assert.equal(response.status,503);assert.equal(await response.text(),'Service temporarily unavailable');assert.equal(response.headers.get('cache-control'),'no-store');
});
test('origin cache directives cannot cache streamed gateway replies',async()=>{
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('streamed'));controller.close();}});
  const response=await proxyRequest(new Request('https://needware.continuumarc.tech/pricing'),env,async()=>new Response(stream,{status:200,headers:{'Cache-Control':'s-maxage=31536000','X-Origin':'preserved'}}));
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-origin'),'preserved');assert.equal(await response.text(),'streamed');
});
test('the Workers entrypoint handles execution context without treating it as an upstream',async()=>{
  const original=globalThis.fetch;let called=false;globalThis.fetch=async request=>{called=true;assert.equal(request.headers.get('host'),'needware-test.onrender.com');return new Response('entrypoint');};
  try{const response=await worker.fetch(new Request('https://needware.continuumarc.tech/'),env,{waitUntil(){}});assert.equal(await response.text(),'entrypoint');assert.equal(called,true);}finally{globalThis.fetch=original;}
});
test('plaintext traffic never reaches the account origin',async()=>{
  let calls=0;const upstream=async()=>{calls++;return new Response('unexpected');};
  const get=await proxyRequest(new Request('http://needware.continuumarc.tech/pricing'),env,upstream);assert.equal(get.status,308);assert.equal(get.headers.get('location'),'https://needware.continuumarc.tech/pricing');
  assert.equal((await proxyRequest(new Request('http://needware.continuumarc.tech/api/auth/sign-in/email',{method:'POST',body:'private'}),env,upstream)).status,426);assert.equal(calls,0);
});
