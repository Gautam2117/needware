import type {ViewNode} from '@needware/ir-types/ViewNode';
import type {Value} from '@needware/ir-types/Value';
import type {DataType} from '@needware/ir-types/DataType';
export type Raw=string|boolean|string[];
export type Draft={id:string;raw:Raw;value?:Value;baseline?:Value;dirty:boolean;conflict:boolean;invalid?:string};
const scopes=new Map<string,Map<string,Draft>>();
const listeners=new Set<()=>void>();let version=0;
export const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const snapshot=()=>version;
export function notify(){version++;for(const listener of listeners)listener();}
export const scopeOf=(node:ViewNode)=>node.form_scope??(node.record?`row:${node.record}`:'global');
export const same=(a:Value|undefined,b:Value|undefined)=>JSON.stringify(a)===JSON.stringify(b);
export function base(type:DataType):DataType{return type.type==='optional'?base(type.inner):type;}
export function decimalText(coefficient:string,scale:number):string{
  const negative=coefficient.startsWith('-'),digits=(negative?coefficient.slice(1):coefficient).padStart(scale+1,'0');
  return `${negative?'-':''}${scale?`${digits.slice(0,-scale)}.${digits.slice(-scale)}`:digits}`;
}
export function display(value:Value|undefined):Raw{
  if(!value||value.type==='null')return '';
  if(value.type==='decimal')return decimalText(value.value.coefficient,value.value.scale);
  if(value.type==='boolean')return value.value;
  if(value.type==='list')return value.value.flatMap(item=>item.type==='string'?[item.value]:[]);
  if(value.type==='datetime'){const date=new Date(value.value);return Number.isNaN(date.valueOf())?'':date.toISOString().replace(/Z$/,'');}
  return 'value' in value&&typeof value.value==='string'?value.value:'';
}
export function initial(node:ViewNode):Value|undefined{
  if(node.value)return node.value;
  if(node.input_contract?.data_type.type==='optional')return {type:'null'};
  const type=node.input_contract&&base(node.input_contract.data_type);
  if(type?.type==='boolean')return {type:'boolean',value:false};
  if(type?.type==='list')return {type:'list',value:[]};
  return undefined;
}
export function parse(node:ViewNode,raw:Raw):Value{
  const declared=node.input_contract?.data_type;
  if(raw===''&&declared?.type==='optional')return {type:'null'};
  const type=declared?base(declared):{type:node.kind==='numeric_input'?'integer':node.kind==='date_input'?'date':node.kind==='datetime_input'?'datetime':'string'};
  if(type.type==='boolean')return {type:'boolean',value:raw===true};
  if(type.type==='list')return {type:'list',value:(Array.isArray(raw)?raw:[]).map(value=>({type:'string',value}))};
  if(typeof raw!=='string')throw Error('Enter a valid value.');
  if((type.type==='integer'||type.type==='decimal')&&raw.length>200)throw Error('Number is too long.');
  if(type.type==='integer'){if(!/^-?\d+$/.test(raw))throw Error('Enter a whole number.');return {type:'integer',value:BigInt(raw).toString()};}
  if(type.type==='decimal'&&'scale' in type){
    const match=/^(-?)(\d+)(?:\.(\d*))?$/.exec(raw);if(!match||match[3]?.length>type.scale)throw Error(`Use at most ${type.scale} decimal places.`);
    return {type:'decimal',value:{coefficient:BigInt(`${match[1]}${match[2]}${(match[3]??'').padEnd(type.scale,'0')}`).toString(),scale:type.scale}};
  }
  if(type.type==='datetime'){const date=new Date(`${raw}Z`);if(Number.isNaN(date.valueOf()))throw Error('Enter a valid date and time in UTC.');return {type:'datetime',value:date.toISOString()};}
  if(type.type==='date'){if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))throw Error('Enter a valid date.');return {type:'date',value:raw};}
  return {type:'string',value:raw};
}
export function draftFor(node:ViewNode):Draft{
  const key=scopeOf(node),field=node.field!;let scope=scopes.get(key);if(!scope){scope=new Map();scopes.set(key,scope);}
  let draft=scope.get(field);if(!draft||draft.id!==node.id){const value=initial(node);draft={id:node.id,raw:display(value),value,baseline:value,dirty:false,conflict:false};scope.set(field,draft);}return draft;
}
export function reconcile(draft:Draft,node:ViewNode){
  const value=initial(node);
  if(!draft.dirty||!draft.invalid&&draft.value!==undefined&&same(value,draft.value)){draft.raw=display(value);draft.value=value;draft.baseline=value;draft.dirty=false;draft.conflict=false;draft.invalid=undefined;}
  else if(!same(value,draft.baseline)){draft.conflict=true;}
}
export function syncDraft(node:ViewNode){const draft=draftFor(node),before=JSON.stringify(draft);reconcile(draft,node);if(JSON.stringify(draft)!==before)notify();}
export function editDraft(node:ViewNode,raw:Raw){const draft=draftFor(node);let bytes=JSON.stringify(raw).length*2,count=1;for(const scope of scopes.values())for(const other of scope.values())if(other!==draft&&other.dirty){bytes+=JSON.stringify(other.raw).length*2;count++;}if(bytes>4*1024*1024||count>4096){draft.invalid='Draft limit reached. Save or review current edits before entering more.';notify();return;}draft.raw=raw;draft.dirty=true;try{draft.value=parse(node,raw);draft.invalid=undefined;}catch(error){draft.value=undefined;draft.invalid=String(error);}notify();}
export function releaseDraft(id:string,field:string|null,key:string){if(!field)return;const scope=scopes.get(key),draft=scope?.get(field);if(draft?.id===id&&!draft.dirty){scope?.delete(field);if(!scope?.size)scopes.delete(key);}}
export function acceptSaved(node:ViewNode){const draft=draftFor(node);draft.dirty=false;reconcile(draft,node);notify();}
export function keepDraft(node:ViewNode){const draft=draftFor(node);draft.baseline=initial(node);draft.conflict=false;notify();}
export function valuesFor(node:ViewNode):Record<string,Value>{
  const values:Record<string,Value>=Object.create(null);for(const [field,draft] of scopes.get(scopeOf(node))??[]){
    if(node.event_fields&&!node.event_fields.includes(field))continue;
    if(draft.conflict||draft.invalid)throw Error(draft.conflict?'Review changed values before submitting.':draft.invalid);
    if(draft.value)values[field]=draft.value;
  }return values;
}
export function dirtyCount(){let count=0;for(const scope of scopes.values())for(const draft of scope.values())if(draft.dirty)count++;return count;}
export function captureDrafts(node:ViewNode){const captured:{draft:Draft;raw:string}[]=[];for(const [field,draft] of scopes.get(scopeOf(node))??[])if(draft.dirty&&(!node.event_fields||node.event_fields.includes(field)))captured.push({draft,raw:JSON.stringify(draft.raw)});return captured;}
export function acknowledgeDrafts(captured:ReturnType<typeof captureDrafts>){for(const item of captured)if(JSON.stringify(item.draft.raw)===item.raw){item.draft.dirty=false;item.draft.conflict=false;item.draft.invalid=undefined;}notify();}
export function exportDrafts(){const entries=[];for(const [scope,fields] of scopes)for(const [field,draft] of fields)if(draft.dirty)entries.push({scope,field,id:draft.id,raw:draft.raw,baseline:draft.baseline});if(JSON.stringify(entries).length*2>8*1024*1024)throw Error('Draft recovery exceeds 8 MiB. Save or review some inputs first.');return entries;}
export function importDrafts(value:unknown,view:ViewNode){
  if(dirtyCount())throw Error('Save or export your current drafts before importing another recovery file.');
  if(!Array.isArray(value)||value.length>4096||JSON.stringify(value).length*2>8*1024*1024)throw Error('Invalid or oversized draft recovery.');
  const nodes=new Map<string,ViewNode>();const visit=(node:ViewNode)=>{if(node.field)nodes.set(`${scopeOf(node)}\0${node.field}\0${node.id}`,node);for(const child of node.children)visit(child);};visit(view);
  const staged:{node:ViewNode;draft:Draft}[]=[];const seen=new Set<string>();let bytes=0;
  for(const entry of value){
    if(!entry||typeof entry!=='object'||typeof entry.scope!=='string'||typeof entry.field!=='string'||typeof entry.id!=='string'||!(typeof entry.raw==='string'||typeof entry.raw==='boolean'||Array.isArray(entry.raw)&&entry.raw.length<=4096&&entry.raw.every((item:unknown)=>typeof item==='string')))throw Error('Invalid recovered field.');
    const key=`${entry.scope}\0${entry.field}\0${entry.id}`,node=nodes.get(key);if(!node||seen.has(key))throw Error('Recovery field is unavailable. Open its original application screen before importing.');seen.add(key);
    bytes+=JSON.stringify(entry.raw).length*2;if(bytes>4*1024*1024)throw Error('Recovered drafts exceed the 4 MiB editing limit.');
    const draft:Draft={id:node.id,raw:entry.raw,baseline:initial(node),dirty:true,conflict:true};try{draft.value=parse(node,entry.raw);}catch(error){draft.invalid=String(error);}staged.push({node,draft});
  }
  for(const {node,draft} of staged){const key=scopeOf(node);let scope=scopes.get(key);if(!scope){scope=new Map();scopes.set(key,scope);}scope.set(node.field!,draft);}notify();
}
