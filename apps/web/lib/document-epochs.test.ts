import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {binding,membership,transition} from './document-proof';
vi.mock('./cloud-request',()=>({CloudError:class extends Error {constructor(readonly status:number,message:string){super(message);}}}));
const fixture=JSON.parse(readFileSync(new URL('../../../artifacts/epoch-proof-fixture.json',import.meta.url),'utf8'));
const authority=Buffer.from(fixture.authority);
const before=binding(fixture.previous,fixture.previous.document.document),after=binding(fixture.next,fixture.next.document.document);
describe('native owner document-epoch authorization',()=>{
  it('verifies actual native canonical binding digests, owner signatures and new grants',()=>{
    expect(transition(fixture.transition,before,after,fixture.root,authority)).toEqual(fixture.transition);
    expect(membership(fixture.membership,after,authority,fixture.root.epoch)).toEqual(fixture.membership);
  });
  it('rejects every modified digest and every signature-byte mutation',()=>{
    for(const name of ['previous_binding','next_binding','history','baseline']){
      const altered=structuredClone(fixture.transition);altered.digests[name][0]^=1;
      expect(()=>transition(altered,before,after,fixture.root,authority)).toThrow();
    }
    for(let index=0;index<64;index++){
      const altered=structuredClone(fixture.transition);altered.signature[index]^=1;
      expect(()=>transition(altered,before,after,fixture.root,authority)).toThrow();
    }
  });
  it('pins source identity, current root, exact increments and the unchanged application/schema',()=>{
    const altered=structuredClone(after);altered.generation++;
    expect(()=>transition(fixture.transition,before,altered,fixture.root,authority)).toThrow();
    for(const name of ['application','revision','schema_digest'] as const){
      const target={...after,[name]:'00000000-0000-4000-8000-000000000000'};
      expect(()=>transition(fixture.transition,before,target,fixture.root,authority)).toThrow();
    }
    expect(()=>transition(fixture.transition,before,{...after,schema_epoch:2},fixture.root,authority)).toThrow();
    expect(()=>transition(fixture.transition,before,after,{...fixture.root,epoch:2},authority)).toThrow();
    const wrong=Buffer.from(authority);wrong[0]^=1;
    expect(()=>transition(fixture.transition,before,after,fixture.root,wrong)).toThrow();
    expect(()=>transition({...fixture.transition,extra:true},before,after,fixture.root,authority)).toThrow();
    expect(()=>transition({...fixture.transition,signature:[]},before,after,fixture.root,authority)).toThrow();
  });
});
