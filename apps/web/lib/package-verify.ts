import 'server-only';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {PackageInfo} from '../../../packages/browser-host/src/protocol';
import {CloudError} from './cloud-request';
let runtime:Promise<{inspect_package:(bytes:Uint8Array)=>string}>|undefined;
async function nativeRuntime(){
  if(!runtime)runtime=(async()=>{
    const directory=join(process.cwd(),'public','wasm');
    const moduleUrl=pathToFileURL(join(directory,'needware_wasm.js')).href;
    const wasm=await import(/* webpackIgnore: true */moduleUrl);
    await wasm.default({module_or_path:await readFile(join(directory,'needware_wasm_bg.wasm'))});return wasm;
  })().catch(error=>{runtime=undefined;throw error;});
  return runtime;
}
export async function verifyRegistryPackage(bytes:Uint8Array):Promise<PackageInfo>{
  if(bytes.length<40||bytes.length>4194304)throw new CloudError(413,'Published package must be at most 4 MiB');
  const wasm=await nativeRuntime();
  try{return JSON.parse(wasm.inspect_package(bytes)) as PackageInfo;}
  catch{throw new CloudError(400,'Signed package validation failed');}
}
