// Explicit allowlist: never upload the checkout, ignored configuration, or credentials.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {chmod,copyFile,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
const root='artifacts/deno-host-probe';
const nativeTarget=process.platform==='linux'?'x86_64-unknown-linux-musl':null;
const nativeBinary=nativeTarget?`target/${nativeTarget}/release/needware-control-plane`:'target/release/needware-control-plane';
if(nativeTarget){
  assert.ok(!/\bINTERP\b/.test(execFileSync('readelf',['-l',nativeBinary],{encoding:'utf8'})),'Host probe must not depend on a dynamic loader');
  assert.ok(!/\(NEEDED\)/.test(execFileSync('readelf',['-d',nativeBinary],{encoding:'utf8'})),'Host probe must not depend on host shared libraries');
}
const files=[
  ['infra/deno/probe.mjs','probe.mjs'],
  [nativeBinary,'needware-control-plane'],
  ['tests/fixtures/provider-server.mjs','tests/fixtures/provider-server.mjs'],
  ['artifacts/compiler-fixture.json','artifacts/compiler-fixture.json'],
  ['apps/web/public/wasm/needware_wasm.js','wasm/needware_wasm.js'],
  ['apps/web/public/wasm/needware_wasm_bg.wasm','wasm/needware_wasm_bg.wasm'],
];
const git=args=>execFileSync('git',args,{encoding:'utf8'}).trim();
const receipt={version:1,scope:'authored fixture compatibility only',release:git(['rev-parse','HEAD']),sourceClean:git(['status','--porcelain'])==='',platform:process.platform,arch:process.arch,nativeTarget,files:[]};
for(const [source,name] of files){
  await mkdir(`${root}/${name.slice(0,name.lastIndexOf('/')+1)}`,{recursive:true});
  const bytes=await readFile(source);
  await copyFile(source,`${root}/${name}`);
  receipt.files.push({name,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await chmod(`${root}/needware-control-plane`,0o755);
await writeFile(`${root}/probe-receipt.json`,JSON.stringify(receipt)+'\n');
async function walk(directory,prefix=''){
  const names=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    assert.ok(entry.isFile()||entry.isDirectory(),'Probe must contain no symlinks or special files');
    const name=prefix+entry.name;
    names.push(...(entry.isDirectory()?await walk(`${directory}/${entry.name}`,name+'/'):[name]));
  }return names;
}
assert.deepEqual((await walk(root)).sort(),[...files.map(([,name])=>name),'probe-receipt.json'].sort(),'Unexpected probe upload contents');
console.log(`Packaged ${files.length} allowlisted files; platform=${receipt.platform}/${receipt.arch}; clean=${receipt.sourceClean}`);
