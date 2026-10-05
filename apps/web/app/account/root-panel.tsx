'use client';
import {useState} from 'react';
import type {AccountVaultClient,RecoveryFile} from './vault-client';
function download(file:RecoveryFile){const url=URL.createObjectURL(new Blob([JSON.stringify(file)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='needware-new-root-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export default function RootPanel({client,busy,run}:{client:AccountVaultClient;busy:boolean;run:(action:()=>Promise<void>|void)=>Promise<void>}){
  const [file,setFile]=useState<RecoveryFile>(),[saved,setSaved]=useState(false),[approved,setApproved]=useState(false),[kept,setKept]=useState<string[]>([]),[message,setMessage]=useState('');
  return <details><summary>Rotate account keys and remove devices</summary>
    <p>Refresh encryption keys for your owned applications. Choose which trusted devices keep future access. Data already downloaded by another device cannot be erased remotely.</p>
    <p>Applications shared by another owner pause shared writes until that owner renews their keys. Your original offline work stays on this browser.</p>
    {!file?<button disabled={busy} onClick={()=>run(()=>{setFile(client.prepareRootRecovery());setKept(client.devices().map(device=>device.device_id));setSaved(false);setApproved(false);})}>Review account key rotation</button>:<>
      <fieldset disabled={busy}><legend>Devices keeping access</legend>{client.devices().map(device=><label key={device.device_id}><input type="checkbox" checked={kept.includes(device.device_id)} disabled={device.device_id===client.deviceId()} onChange={event=>setKept(values=>event.target.checked?[...values,device.device_id]:values.filter(value=>value!==device.device_id))}/>{device.label}{device.device_id===client.deviceId()?' (this browser)':''}<code>{device.device_id}</code></label>)}</fieldset>
      <p>Your old recovery code will stop unlocking the current account. Save the new file privately before continuing.</p>
      <button disabled={busy} onClick={()=>download(file)}>Download new recovery file</button>
      <label><input type="checkbox" checked={saved} onChange={event=>setSaved(event.target.checked)} disabled={busy}/>I saved the new recovery file outside this browser</label>
      <label><input type="checkbox" checked={approved} onChange={event=>setApproved(event.target.checked)} disabled={busy}/>I approve fresh application keys, synchronization of current shared edits, and removal of unselected devices</label>
      <button disabled={busy||!saved||!approved} onClick={()=>run(async()=>{const pending=await client.rotateRoot(kept,saved);setFile(undefined);setMessage(pending?`Account keys rotated. ${pending} shared application${pending===1?'':'s'} need their owner's fresh-key approval before shared writes resume.`:'Account keys rotated. Selected devices can accept the new keys.');})}>Rotate account keys</button>
    </>}{message&&<p role="status">{message}</p>}
  </details>;
}
