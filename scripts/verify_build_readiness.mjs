import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {buildReady} from './build-readiness.mjs';
assert.equal(await buildReady(),true,'Fresh complete build receipt required');
for(const name of ['apps/web/public/wasm/needware_wasm.js','apps/web/.next/server/middleware-manifest.json','scripts/production-config.mjs','apps/web/.next/needware-build-receipt.json']){
  const original=await readFile(name);
  try{await writeFile(name,Buffer.concat([original,Buffer.from('\nINJECTED_BUILD_DRIFT\n')]));assert.equal(await buildReady(),false,name);}
  finally{await writeFile(name,original);}
  assert.deepEqual(await readFile(name),original);assert.equal(await buildReady(),true);
}
await mkdir('apps/web/.next/server/route-cache',{recursive:true});
const cache=`apps/web/.next/server/route-cache/preflight-${randomUUID()}`;
try{await writeFile(cache,'runtime cache fixture',{flag:'wx'});assert.equal(await buildReady(),true);}finally{await unlink(cache);}
console.log('PASS immutable server/browser tamper, source drift and invalid receipt rejection; runtime route cache allowed and exact bytes restored');
