import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { retainedRootDevices, rootDeviceApproval } from './root-rotation-devices';
vi.mock('./cloud-request',()=>({CloudError:class extends Error{constructor(readonly status:number,message:string){super(message);}}}));
const fixture=JSON.parse(readFileSync(new URL('../../../artifacts/epoch-proof-fixture.json',import.meta.url),'utf8'));
const actor=fixture.previous_certificate,approval=fixture.retained_approval;
const choices=[{certificate:fixture.rotated_approval.certificate,approval:null},{certificate:approval.certificate,approval}];
const registered=[{certificate:actor,label:'Current browser'},{certificate:fixture.retained_previous_certificate,label:'Trusted browser'}];
describe('native root-device selection and HPKE attestations',()=>{
  it('authenticates native approvals and retains only explicit existing device identities',()=>{
    expect(rootDeviceApproval(approval,approval.certificate)).toEqual(approval);
    expect(retainedRootDevices(choices,fixture.root_rotation,actor,registered)).toHaveLength(2);
    expect(retainedRootDevices(choices.slice(0,1),fixture.root_rotation,actor,registered)).toHaveLength(1);
  });
  it('rejects every HPKE signature mutation and wrong ciphertext, recipient, or epoch',()=>{
    for(let i=0;i<64;i++){const altered=structuredClone(approval);altered.envelope.signature[i]^=1;expect(()=>rootDeviceApproval(altered,approval.certificate)).toThrow();}
    for(const field of ['ciphertext','encapsulated']){const altered=structuredClone(approval);altered.envelope[field][0]^=1;expect(()=>rootDeviceApproval(altered,approval.certificate)).toThrow();}
    expect(()=>rootDeviceApproval(approval,actor)).toThrow();
    const altered=structuredClone(approval);altered.envelope.root_epoch++;expect(()=>rootDeviceApproval(altered,approval.certificate)).toThrow();
  });
  it('rejects removing the current device, duplicates, unregistered keys, and missing approvals',()=>{
    expect(()=>retainedRootDevices(choices.slice(1),fixture.root_rotation,actor,registered)).toThrow();
    expect(()=>retainedRootDevices([...choices,choices[0]],fixture.root_rotation,actor,registered)).toThrow();
    expect(()=>retainedRootDevices(choices,fixture.root_rotation,actor,registered.slice(0,1))).toThrow();
    expect(()=>retainedRootDevices([choices[0],{...choices[1],approval:null}],fixture.root_rotation,actor,registered)).toThrow();
    expect(()=>retainedRootDevices([{...choices[0],approval:fixture.rotated_approval}],fixture.root_rotation,actor,registered)).toThrow();
    const wrong=structuredClone(registered);wrong[1].certificate.device.signing[0]^=1;expect(()=>retainedRootDevices(choices,fixture.root_rotation,actor,wrong)).toThrow();
  });
});
