import canonicalize from 'canonicalize';
import { CloudError } from './cloud-request';
import { bytes, certificate, checkSignature, object, type Certificate } from './vault-proof';
import type { RootRotation } from './root-rotation-proof';
export type RootDevice = { certificate: Certificate; approval: unknown | null; label: string };
export type RegisteredRootDevice = { certificate: Certificate; label: string };
const same=(left:unknown,right:unknown)=>canonicalize(left)===canonicalize(right);

/** Verify the native HPKE attestation without ever receiving its plaintext root. */
export function rootDeviceApproval(value:unknown,cert:Certificate):unknown {
  const approval=object(value,['certificate','envelope']);
  if(!same(approval.certificate,cert))throw new CloudError(403,'Root approval certificate mismatch');
  const envelope=object(approval.envelope,['context','root_epoch','authority','recipient','encapsulated','ciphertext','signature']);
  if(!same(envelope.context,cert.context)||envelope.root_epoch!==cert.context.epoch||!same(envelope.authority,cert.authority)||!same(envelope.recipient,cert.device))throw new CloudError(403,'Root approval recipient mismatch');
  const encapsulated=bytes(envelope.encapsulated,32),ciphertext=bytes(envelope.ciphertext,48),signature=bytes(envelope.signature,64);
  const aad=Buffer.concat([Buffer.from('NEEDWARE-HPKE-KEY\0'),Buffer.from(canonicalize([cert.context,cert.context.epoch,cert.authority,cert.device])!)]);
  checkSignature(cert.authority,'NEEDWARE-HPKE-ATTESTATION',[Array.from(aad),encapsulated,ciphertext],signature);
  return approval;
}

export function retainedRootDevices(value:unknown,rotation:RootRotation,actor:Certificate,registered:RegisteredRootDevice[]):RootDevice[] {
  if(!Array.isArray(value)||!value.length||value.length>10)throw new CloudError(400,'Choose 1 to 10 trusted root devices');
  const seen=new Set<string>(),devices:RootDevice[]=[];
  for(const raw of value){
    const item=object(raw,['certificate','approval']),cert=certificate(item.certificate,actor.context.account);
    const existing=registered.find(device=>device.certificate.device.id===cert.device.id);
    if(seen.has(cert.device.id))throw new CloudError(400,'Duplicate trusted root device');seen.add(cert.device.id);
    if(!existing||!same(existing.certificate.device,cert.device)||!same(cert.context,rotation.transition.next)||!same(cert.authority,rotation.transition.next_authority))throw new CloudError(403,'Root rotation cannot substitute or enroll a device');
    const current=cert.device.id===actor.device.id;
    if(current?!same(cert.device,actor.device)||item.approval!==null:item.approval===null)throw new CloudError(403,'Current trusted device and retained-device approvals required');
    const approval=current?null:rootDeviceApproval(item.approval,cert);
    devices.push({certificate:cert,approval,label:existing.label});
  }
  if(!seen.has(actor.device.id))throw new CloudError(403,'Use another trusted device to remove the current one');
  return devices.sort((left,right)=>left.certificate.device.id.localeCompare(right.certificate.device.id));
}
