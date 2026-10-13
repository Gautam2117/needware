import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generationAllowed} from '../apps/web/lib/generation-access.ts';
const owner='a6949e9a-abad-4614-b06c-e495c5ff8ea2',other='dcad68cb-06b4-4756-88ce-40c244161480',now=Date.parse('2026-10-13T18:00:00Z');
const base={NEEDWARE_HOSTED_GENERATION:'1',NEEDWARE_OPERATOR_ACCOUNTS:owner};
const canary={...base,NEEDWARE_GENERATION_CANARY_ACCOUNT:owner,NEEDWARE_GENERATION_CANARY_STARTED_AT:new Date(now-1000).toISOString(),NEEDWARE_GENERATION_CANARY_UNTIL:new Date(now+60000).toISOString()};
test('paused feature denies normal and operator admission',()=>{assert.equal(generationAllowed(owner,{...canary,NEEDWARE_HOSTED_GENERATION:'0'},now),false);});
test('bounded canary admits only its existing operator',()=>{assert.equal(generationAllowed(owner,canary,now),true);assert.equal(generationAllowed(other,canary,now),false);assert.equal(generationAllowed(owner,{...canary,NEEDWARE_OPERATOR_ACCOUNTS:other},now),false);});
test('expired and partial canaries never reopen public admission',()=>{
 for(const change of [{NEEDWARE_GENERATION_CANARY_UNTIL:new Date(now).toISOString()},{NEEDWARE_GENERATION_CANARY_STARTED_AT:''},{NEEDWARE_GENERATION_CANARY_ACCOUNT:''},{NEEDWARE_GENERATION_CANARY_UNTIL:new Date(now+1800001).toISOString()}])assert.equal(generationAllowed(owner,{...canary,...change},now),false);
});
test('normal admission resumes only after every canary field is removed',()=>{assert.equal(generationAllowed(other,base,now),true);assert.equal(generationAllowed(other,{...base,NEEDWARE_GENERATION_CANARY_UNTIL:canary.NEEDWARE_GENERATION_CANARY_UNTIL},now),false);});
