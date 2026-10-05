import {createHash} from 'node:crypto';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const hash=value=>createHash('sha256').update(value).digest('hex');
const receipt='apps/web/.next/needware-build-receipt.json';
export async function sourceDigest(){
  const names=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','--','apps/web','packages','crates','services/control-plane','Cargo.lock','Cargo.toml','rust-toolchain.toml','pnpm-lock.yaml','package.json','scripts'],{encoding:'utf8'}).split('\0').filter(Boolean).sort();
  const digest=createHash('sha256');for(const name of names)digest.update(name+'\0').update(await readFile(name));return digest.digest('hex');
}
async function walk(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(entry=>entry.isDirectory()?walk(`${dir}/${entry.name}`):[`${dir}/${entry.name}`]))).flat();}
export async function buildReceipt(){
  const generated=['runtime-worker.js','encrypted-worker.js','vault-store.js','sync-journal.js','relay-client.js','root-publication.js','frame.js','wasm/needware_wasm.js','wasm/needware_wasm_bg.wasm','sqlite3.wasm','sw.js'];
  const server=(await walk('apps/web/.next/server')).filter(name=>!name.startsWith('apps/web/.next/server/route-cache/'));
  const names=[...await walk('apps/web/.next/static'),...server,...await walk('apps/web/public/sqlite'),...generated.map(name=>`apps/web/public/${name}`),'apps/web/.next/BUILD_ID','apps/web/.next/routes-manifest.json','apps/web/.next/required-server-files.json'].sort();
  let control=null;try{control=hash(await readFile('target/release/needware-control-plane'));}catch{}
  return {version:1,source:await sourceDigest(),control,files:await Promise.all(names.map(async name=>({name,sha256:hash(await readFile(name))})))};
}
export async function buildReady(){
  try{return JSON.stringify(JSON.parse(await readFile(receipt,'utf8')))===JSON.stringify(await buildReceipt());}catch{return false;}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.includes('--record')){await writeFile(receipt,JSON.stringify(await buildReceipt())+'\n');console.log('Build integrity receipt recorded');}
  else{const ok=await buildReady();console.log(ok?'PASS build integrity':'FAIL BUILD_ARTIFACTS');process.exitCode=ok?0:1;}
}
