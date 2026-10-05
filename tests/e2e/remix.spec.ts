import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
test('remix copies verified definitions with independent identity and signed lineage, without runtime state',async({page})=>{
  const source=Array.from(await readFile('artifacts/revisions/source.need'));await page.goto('/');
  const result=await page.evaluate(async source=>{
    const path='/wasm/needware_wasm.js',wasm=await import(/* webpackIgnore: true */path);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const bytes=new Uint8Array(source),info=JSON.parse(wasm.inspect_package(bytes)),original=new wasm.BrowserRuntime(bytes,undefined,true);
    original.dispatch(JSON.stringify({action:'add',values:{record_id:{type:'string',value:crypto.randomUUID()},name:{type:'string',value:'Original private data'}},now:'2026-10-05T00:00:00Z',timezone:'UTC'}));
    const before=original.snapshot(),application=crypto.randomUUID(),revision=crypto.randomUUID();let consent=false,identity=false,tamper=false;
    try{wasm.remix_package(bytes,application,revision,false);}catch{consent=true;}
    try{wasm.remix_package(bytes,info.application.id,revision,true);}catch{identity=true;}
    const modified=bytes.slice();modified[modified.length-1]^=1;try{wasm.remix_package(modified,application,revision,true);}catch{tamper=true;}
    const copy=wasm.remix_package(bytes,application,revision,true),copied=JSON.parse(wasm.inspect_package(copy)),runtime=new wasm.BrowserRuntime(copy,undefined,true);
    const result={consent,identity,tamper,unchanged:original.snapshot()===before,application:copied.application.id===application,revision:copied.application.revision===revision,parent:copied.application.parent===info.digest,permissions:JSON.stringify(copied.application.capabilities)===JSON.stringify(info.application.capabilities),newSigner:copied.signers[0]!==info.signers[0],privateData:runtime.snapshot().includes('Original private data')};runtime.free();original.free();return result;
  },source);
  expect(result).toEqual({consent:true,identity:true,tamper:true,unchanged:true,application:true,revision:true,parent:true,permissions:true,newSigner:true,privateData:false});
});
