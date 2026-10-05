// Private raw edits stay in the encrypted local document journal, never sync frames.
export interface DraftEntry {scope:string;field:string;id:string;raw:string|boolean|string[]}
export interface DraftSnapshot {id:string;digest:string;generation:number;fields:DraftEntry[]}
export interface DraftSummary {source:number;id:string;digest:string;generation:number;count:number}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function draftIdentity(id:string,digest:string):void{if(!uuid.test(id)||!/^[0-9a-f]{64}$/.test(digest))throw Error('Invalid encrypted draft identity.');}
export function draftEntries(value:unknown):DraftEntry[]{
  if(!Array.isArray(value)||value.length>4096)throw Error('Encrypted draft field limit.');
  const seen=new Set<string>();let rawBytes=0;
  const fields=value.map(entry=>{
    if(!entry||typeof entry!=='object'||Object.keys(entry).some(key=>!['scope','field','id','raw','baseline'].includes(key))||![entry.scope,entry.field,entry.id].every(part=>typeof part==='string'&&part.length>0&&part.length<=2048&&!part.includes('\0'))||!(typeof entry.raw==='string'||typeof entry.raw==='boolean'||Array.isArray(entry.raw)&&entry.raw.length<=4096&&entry.raw.every((item:unknown)=>typeof item==='string')))throw Error('Invalid encrypted draft field.');
    const key=JSON.stringify([entry.scope,entry.field,entry.id]);if(seen.has(key))throw Error('Duplicate encrypted draft field.');seen.add(key);
    rawBytes+=JSON.stringify(entry.raw).length*2;if(rawBytes>4*1024*1024)throw Error('Encrypted drafts exceed the editing limit.');
    return {scope:entry.scope,field:entry.field,id:entry.id,raw:Array.isArray(entry.raw)?[...entry.raw]:entry.raw} as DraftEntry;
  });
  if(JSON.stringify(fields).length*2>8*1024*1024)throw Error('Encrypted draft snapshot is too large.');return fields;
}
export function draftSnapshots(value:unknown):DraftSnapshot[]{
  if(!Array.isArray(value)||value.length>8)throw Error('Encrypted draft recovery is full. Export and review earlier recoveries first.');
  const seen=new Set<string>();const records=value.map(record=>{
    if(!record||typeof record!=='object'||Object.keys(record).sort().join(',')!=='digest,fields,generation,id'||!Number.isSafeInteger(record.generation)||record.generation<1)throw Error('Invalid encrypted draft snapshot.');
    draftIdentity(record.id,record.digest);if(seen.has(record.id))throw Error('Duplicate encrypted draft snapshot.');seen.add(record.id);
    return {id:record.id,digest:record.digest,generation:record.generation,fields:draftEntries(record.fields)};
  });
  if(JSON.stringify(records).length*2>8*1024*1024)throw Error('Encrypted draft recovery storage limit. Earlier edits remain preserved.');return records;
}
