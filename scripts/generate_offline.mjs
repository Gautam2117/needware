import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const publicDir = 'apps/web/public';
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))).flat();
}
const staticFiles = await files('apps/web/.next/static');
const runtimeFiles = ['runtime-worker.js', 'encrypted-worker.js', 'vault-store.js', 'sync-journal.js', 'relay-client.js', 'frame.js', 'wasm/needware_wasm.js', 'wasm/needware_wasm_bg.wasm', 'sqlite3.wasm', 'manifest.webmanifest'];
const hash = createHash('sha256');
for (const file of [...staticFiles, ...runtimeFiles.map(f => `${publicDir}/${f}`)].sort()) hash.update(file).update(await readFile(file));
const version = hash.digest('hex').slice(0, 24);
const assets = ['/', '/encrypted', ...staticFiles.map(f => f.replace('apps/web/.next', '/_next')), ...runtimeFiles.map(f => `/${f}`)];
await writeFile(`${publicDir}/sw.js`, `
const CACHE=${JSON.stringify(`needware-${version}`)};
const ASSETS=${JSON.stringify(assets)};
self.addEventListener('install',event=>event.waitUntil((async()=>{
  try { await (await caches.open(CACHE)).addAll(ASSETS); }
  catch(error) { await caches.delete(CACHE); throw error; }
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys()) if(key.startsWith('needware-')&&key!==CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!ASSETS.includes(url.pathname)) return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const hit=await cache.match(url.pathname);
    return hit||fetch(event.request);
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.kind!=='needware-claim-ready-client'||!event.source?.id)return;
  event.waitUntil((async()=>{
    const client=await self.clients.get(event.source.id);
    if(client&&new URL(client.url).origin===self.location.origin)await self.clients.claim();
  })());
});
`);
console.log(`Production offline cache: ${assets.length} assets; identity ${version}`);
