// Streaming canonical-origin gateway. No application state, credentials or model work lives at the edge.
const unavailable=()=>new Response('Service temporarily unavailable',{status:503,headers:{'Cache-Control':'no-store'}});
export async function proxyRequest(request,env,upstream=fetch,assetCache=globalThis.caches?.default){
  const url=new URL(request.url);let origin;
  try{origin=new URL(env.NEEDWARE_RENDER_ORIGIN);}catch{return unavailable();}
  if(origin.protocol!=='https:'||! /^[a-z0-9-]+\.onrender\.com$/.test(origin.hostname)||origin.port||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password
    ||env.NEEDWARE_CANONICAL_HOST!=='needware.continuumarc.tech'||! /^[0-9a-f]{64}$/.test(env.NEEDWARE_EDGE_ORIGIN_PROOF??''))return unavailable();
  if(url.hostname!==env.NEEDWARE_CANONICAL_HOST){
    const publicPath=['/','/pricing','/privacy','/terms','/refunds','/encrypted','/account','/billing','/registry','/api/health'].includes(url.pathname)
      ||url.pathname.startsWith('/_next/static/')||url.pathname.startsWith('/wasm/')||url.pathname.startsWith('/sqlite/')||/^\/[a-z0-9._-]+\.(?:js|wasm|svg|png|ico)$/.test(url.pathname);
    if(url.hostname!==env.NEEDWARE_STAGING_HOST||!['GET','HEAD'].includes(request.method)||!publicPath)return new Response('Not available on this hostname',{status:421,headers:{'Cache-Control':'no-store'}});
  }
  if(url.protocol!=='https:'){
    if(!['GET','HEAD'].includes(request.method))return new Response('HTTPS required',{status:426,headers:{'Cache-Control':'no-store'}});
    const secure=new URL(url);secure.protocol='https:';secure.port='';return Response.redirect(secure,308);
  }
  const target=new URL(origin);target.pathname=url.pathname;target.search=url.search;
  // Only content-addressed Next assets may survive an origin outage. Never cache pages or APIs.
  const immutable=request.method==='GET'&&!url.search&&/^\/_next\/static\/(chunks|css|media)\/[A-Za-z0-9_./-]+\.(js|css|woff2?|ttf|otf|png|jpg|jpeg|svg|webp|avif)$/.test(url.pathname);
  const cacheKey=immutable?new Request(url.href,{method:'GET'}):null;
  if(cacheKey&&assetCache){try{const cached=await assetCache.match(cacheKey);if(cached)return cached;}catch{/* Origin remains available if the cache fails. */}}
  const outbound=new Request(target,request);
  outbound.headers.set('Host',origin.host);
  const client=request.headers.get('cf-connecting-ip')??'';
  for(const key of ['x-needware-auth-ip','x-needware-client-ip','x-needware-origin-proof','x-needware-edge-ip','x-forwarded-for','x-vercel-forwarded-for','x-real-ip','x-forwarded-host','x-forwarded-proto'])outbound.headers.delete(key);
  outbound.headers.set('X-Needware-Origin-Proof',env.NEEDWARE_EDGE_ORIGIN_PROOF);
  outbound.headers.set('X-Needware-Edge-IP',client);
  // Staging is public-only: never carry account credentials onto the alternate hostname.
  if(url.hostname!==env.NEEDWARE_CANONICAL_HOST){outbound.headers.delete('cookie');outbound.headers.delete('authorization');}
  if(immutable){outbound.headers.delete('cookie');outbound.headers.delete('authorization');}
  try{const response=await upstream(outbound,{redirect:'manual',cache:'no-store'});
    const headers=new Headers(response.headers);headers.set('Cache-Control','no-store');
    const cacheable=immutable&&response.status===200&&!headers.has('set-cookie')&&/^(application\/(javascript|x-javascript|font-|octet-stream)|text\/(javascript|css)|font\/|image\/)/i.test(headers.get('content-type')??'');
    if(cacheable)headers.set('Cache-Control','public, max-age=31536000, immutable');
    const result=new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    if(cacheable&&cacheKey&&assetCache){try{await assetCache.put(cacheKey,result.clone());}catch{/* Cache failure must not break an available asset. */}}
    return result;
  }catch{return unavailable();}
}
export async function keepWarm(env,upstream=fetch){
  if(env.NEEDWARE_KEEP_WARM!=='1'||env.NEEDWARE_RENDER_ORIGIN!=='https://needware-free.onrender.com')return false;
  try{
    const response=await upstream(`${env.NEEDWARE_RENDER_ORIGIN}/api/health`,{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(90000)});
    const healthy=response.ok;
    await response.body?.cancel();
    return healthy;
  }catch{return false;}
}
export default {fetch:(request,env)=>proxyRequest(request,env),scheduled:(_event,env,ctx)=>ctx.waitUntil(keepWarm(env))};
