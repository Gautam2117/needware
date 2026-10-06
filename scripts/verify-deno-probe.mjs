import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
const cwd='artifacts/deno-host-probe';
function run(extra=[]){
  const child=spawnSync('npx',['--yes','deno@2.9.6','run','--no-config','--no-lock','-A','probe.mjs','--check',...extra],{cwd,encoding:'utf8',timeout:30000});
  assert.equal(child.error,undefined,'Probe execution failed');
  return {code:child.status,result:JSON.parse(child.stdout)};
}
const positive=run(process.argv.includes('--require-release')?['--require-release']:[]);
assert.equal(positive.code,0);assert.equal(positive.result.status,'PASS');
const receipt=JSON.parse(await readFile(`${cwd}/probe-receipt.json`,'utf8'));
if(!receipt.sourceClean||receipt.platform!=='linux'||receipt.arch!=='x64'){
  const refused=run(['--require-release']);assert.equal(refused.code,1);assert.equal(refused.result.phase,'artifact verification');
}
const path=`${cwd}/wasm/needware_wasm_bg.wasm`,original=await readFile(path);
try{
  const changed=Buffer.from(original);changed[changed.length-1]^=1;await writeFile(path,changed);
  const tampered=run();assert.equal(tampered.code,1);assert.equal(tampered.result.phase,'artifact verification');
}finally{await writeFile(path,original);}
console.log('PASS native fixture probe, release guard and artifact tamper rejection');
