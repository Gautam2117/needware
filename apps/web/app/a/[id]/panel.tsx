'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import type {RegistryEntry} from '../../../lib/registry-store';
export default function ApplicationPage({id}:{id:string}){
  const [entry,setEntry]=useState<RegistryEntry|null>(null),[error,setError]=useState(''),[status,setStatus]=useState('Loading application');
  useEffect(()=>{let active=true;const revision=new URLSearchParams(window.location.search).get('revision'),suffix=revision?`?revision=${encodeURIComponent(revision)}`:'';fetch(`/api/registry/${encodeURIComponent(id)}${suffix}`,{cache:'no-store'}).then(async response=>{const value=await response.json();if(!response.ok)throw Error(value.message);if(active){setEntry(value.application);setStatus('Application ready for review');}}).catch(error=>{if(active)setError(String(error));});return()=>{active=false;};},[id]);
  return <><header><Link href="/">needware /</Link><nav><Link href="/registry">Application registry</Link><Link href="/account">Your account</Link></nav></header><main id="main"><p role="status" aria-live="polite">{status}</p>{error&&<p role="alert" className="notice error">{error}</p>}{entry&&<><h1>{entry.title}</h1><p>{entry.summary}</p><p>{entry.visibility} · published by account {entry.owner_id.slice(0,8)}</p><p>Revision <code>{entry.current_digest}</code></p>
    {entry.document_id?<><p>This application stays encrypted and requires your vault and current document access.</p><Link className="primary" href={`/encrypted#account=${entry.owner_id}&document=${entry.document_id}`}>Open encrypted application library</Link></>:<><p>Review the signer and permissions before running this definition. Your local application data is separate from the shared definition.</p><p>Verified signers: <code>{entry.package_info?.signers.join(', ')}</code></p><ul>{entry.package_info?.application.capabilities.map((item,index)=><li key={index}>{JSON.stringify(item)}</li>)}</ul><div className="toolbar"><Link className="primary" href={`/?registry=${entry.id}&revision=${entry.current_digest}`}>Review and open application</Link><a href={`/api/registry/${entry.id}?revision=${entry.current_digest}&download=1`}>Download signed definition</a></div></>}
    {entry.package_info&&<p><Link href={`/?registry=${entry.id}&revision=${entry.current_digest}&remix=1`}>Remix this application</Link></p>}
    {entry.source_entry&&<p>Remixed from <Link href={`/a/${entry.source_entry}?revision=${entry.source_digest}`}>source application</Link>, revision <code>{entry.source_digest}</code>.</p>}
    {!entry.source_entry&&entry.source_digest&&<p>Signed source revision <code>{entry.source_digest}</code>. Its original registry entry is no longer available.</p>}
    <button onClick={()=>{void navigator.clipboard.writeText(window.location.href).then(()=>setStatus('Sharing link copied')).catch(()=>setError('Select and copy the address from your browser.'));}}>Copy sharing link</button>
  </>}</main></>;
}
