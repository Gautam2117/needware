// Private authored acceptance bundles. Never copied into public runtime assets.
import {build} from 'esbuild';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const folder='artifacts/local-storage';await mkdir(folder,{recursive:true});
const options={bundle:true,format:'esm',platform:'browser',target:'es2022',alias:{'needware-wasm-runtime':'/wasm/needware_wasm.js'},external:['/wasm/*'],minify:true};
const seed=await readFile('tests/fixtures/legacy-local-store.ts','utf8');await build({...options,stdin:{contents:seed,resolveDir:resolve('packages/browser-host/src'),loader:'ts'},outfile:`${folder}/legacy-worker.js`});
const source=await readFile('packages/browser-host/src/worker.ts','utf8'),needle='db.exec(`ALTER TABLE ${table} ADD COLUMN effect TEXT`)';assert.equal(source.split(needle).length-1,1,'Locate the actual transactional second-table migration boundary');
const fault=source.replace(needle,'(()=>{if(table==="history")throw Error("Injected effect schema upgrade failure");db.exec(`ALTER TABLE ${table} ADD COLUMN effect TEXT`);})()');
await build({...options,stdin:{contents:fault,resolveDir:resolve('packages/browser-host/src'),loader:'ts'},outfile:`${folder}/fault-worker.js`});
console.log('Private legacy layout and actual transactional DDL failure fixtures built');
