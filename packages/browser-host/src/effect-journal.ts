import canonicalize from 'canonicalize';
import type {Effect} from '@needware/ir-types/Effect';
import type {EffectOutcome} from '@needware/ir-types/EffectOutcome';
export interface EffectIntent {id:string; status:'prepared'|'dispatching'|'result'; checkpoint:string; state:string; request:Effect; outcome?:EffectOutcome}
const encoder=new TextEncoder();
export function effectIntent(value:unknown):EffectIntent {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid private effect intent');
  const v=value as EffectIntent,keys=['checkpoint','id','request','state','status'];if(v.outcome!==undefined)keys.push('outcome');keys.sort();
  if(Object.keys(v).sort().join(',')!==keys.join(',')||!['prepared','dispatching','result'].includes(v.status)||typeof v.id!=='string'||! /^[0-9a-f-]{36}$/i.test(v.id)||typeof v.checkpoint!=='string'||typeof v.state!=='string'||!v.request||v.request.id!==v.id||!v.request.flow||encoder.encode(JSON.stringify(v)).length>8*1024*1024||((v.status==='result')!==(v.outcome!==undefined)))throw new Error('Invalid or oversized private effect intent');
  const checkpoint=JSON.parse(v.checkpoint) as {version:number;records:{effect:Effect}[]};
  if(checkpoint.version!==1||!Array.isArray(checkpoint.records)||checkpoint.records.length!==1||canonicalize(checkpoint.records[0]?.effect)!==canonicalize(v.request))throw new Error('Effect request disagrees with its verified checkpoint');
  if(v.outcome!==undefined)effectOutcome(v.outcome);
  return structuredClone(v);
}
export function effectOutcome(value:unknown):EffectOutcome {
  if(!value||typeof value!=='object'||Array.isArray(value)||encoder.encode(JSON.stringify(value)).length>1024*1024)throw new Error('Invalid effect outcome');
  const v=value as Record<string,unknown>;
  if(v.status==='success'&&Object.keys(v).sort().join(',')==='status,value')return structuredClone(value) as EffectOutcome;
  if(v.status==='failure'&&Object.keys(v).sort().join(',')==='code,status'&&typeof v.code==='string'&&/^[a-z0-9_]{1,64}$/.test(v.code))return structuredClone(value) as EffectOutcome;
  throw new Error('Invalid effect outcome');
}
