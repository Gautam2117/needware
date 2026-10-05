import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
test('generation package delivery stays encrypted for the requesting device and binds its exact account and job',async({page})=>{
  const bytes=Array.from(await readFile('artifacts/revisions/source.need'));await page.goto('/');
  const result=await page.evaluate(async bytes=>{
    const path='/wasm/needware_wasm.js',wasm=await import(/* webpackIgnore: true */path);await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});
    const account=crypto.randomUUID(),vault=new wasm.BrowserVault(account),peer=new wasm.BrowserVault(undefined),foreign=new wasm.BrowserVault(crypto.randomUUID());
    peer.accept_enrollment(vault.approve_device(peer.device_public(),true),vault.account_context(),vault.account_authority());
    const job=crypto.randomUUID(),context=JSON.stringify({version:1,account,job}),packageBytes=new Uint8Array(bytes),sealed=wasm.seal_generation_package(packageBytes,vault.device_public(),context),metadata=sealed.metadata(),ciphertext=sealed.ciphertext();
    const opened=vault.open_generation_package(job,metadata,ciphertext);let otherDevice=false,otherAccount=false,otherJob=false,tamper=false,invalidPackage=false;
    try{peer.open_generation_package(job,metadata,ciphertext);}catch{otherDevice=true;}
    try{foreign.open_generation_package(job,metadata,ciphertext);}catch{otherAccount=true;}
    try{vault.open_generation_package(crypto.randomUUID(),metadata,ciphertext);}catch{otherJob=true;}
    ciphertext[0]^=1;try{vault.open_generation_package(job,metadata,ciphertext);}catch{tamper=true;}
    packageBytes[packageBytes.length-1]^=1;try{wasm.seal_generation_package(packageBytes,vault.device_public(),context);}catch{invalidPackage=true;}
    const equal=opened.length===bytes.length&&opened.every((value:number,index:number)=>value===bytes[index]);opened.fill(0);
    for(const value of [sealed,vault,peer,foreign])value.free();return {equal,otherDevice,otherAccount,otherJob,tamper,invalidPackage};
  },bytes);expect(result).toEqual({equal:true,otherDevice:true,otherAccount:true,otherJob:true,tamper:true,invalidPackage:true});
});
