import assert from 'node:assert/strict';
import {roles,verifyEndpoints,requestBudget,freeRequest,verifyResponse} from './free-model-policy.mjs';
const selected=roles('layered');
assert.ok(Object.isFrozen(selected));
const metadata=[...new Set(Object.values(selected))].map(route=>({model_id:route.model,tag:route.tag,pricing:{prompt:'0',completion:'0'},supported_parameters:['response_format']}));
verifyEndpoints(metadata,selected);
assert.throws(()=>roles('paid'));
assert.throws(()=>verifyEndpoints([],selected));
for(const mutation of [row=>row.tag='nvidia',row=>row.pricing.prompt='0.000001',row=>row.pricing.request='0.01',row=>delete row.pricing.completion]) {
  const changed=structuredClone(metadata);mutation(changed[0]);assert.throws(()=>verifyEndpoints(changed,selected));
}
assert.equal(requestBudget({free_model_daily_requests:{remaining:50}}),12);
assert.equal(requestBudget({free_model_daily_requests:{remaining:2}}),2);
for(const remaining of [0,-1,NaN,'50',0.5])assert.throws(()=>requestBudget({free_model_daily_requests:{remaining}}));
assert.throws(()=>requestBudget({}));
const original={model:selected.generation.model,messages:[{role:'user',content:'Produce a definition.'}],max_tokens:8192,response_format:{type:'json_schema',json_schema:{schema:{type:'object',properties:{application:{}}}}},plugins:[{id:'web'}],tools:[{type:'function'}],provider:{only:['paid']}};
const generated=freeRequest(original,selected);
assert.throws(()=>freeRequest(original,{...selected,repair:{model:'paid-model',tag:'paid'}}));
assert.equal(generated.role,'generation');assert.equal(generated.body.model,selected.generation.model);
assert.equal(generated.body.provider.allow_fallbacks,false);assert.equal(generated.body.provider.zdr,true);
assert.equal(generated.body.provider.data_collection,'deny');assert.equal(generated.body.provider.require_parameters,true);
assert.deepEqual(generated.body.provider.max_price,{prompt:0,completion:0});
assert.equal(generated.body.plugins,undefined);assert.equal(generated.body.tools,undefined);
assert.equal(generated.body.response_format,undefined);
const intent=structuredClone(original);intent.response_format.json_schema.schema.title='Intent';
assert.equal(freeRequest(intent,selected).body.model,selected.intent.model);
assert.deepEqual(freeRequest(intent,selected).body.response_format,{type:'json_object'});
const repair=structuredClone(original);repair.messages[0].content+=' Previous candidate failed. Generate a corrected full definition; keep all user requirements.';
assert.equal(freeRequest(repair,selected).body.model,selected.repair.model);
for(const mutation of [body=>body.model='paid-model',body=>body.max_tokens=8193,body=>body.messages[0].role='system',body=>delete body.response_format]) {
  const changed=structuredClone(original);mutation(changed);assert.throws(()=>freeRequest(changed,selected));
}
verifyResponse(200,{provider:'Novita',usage:{cost:0}});
verifyResponse(429,{error:{code:429}});
for(const response of [{provider:'Novita',usage:{cost:0.01}},{provider:'NVIDIA',usage:{cost:0}},{provider:'Novita',usage:{}},{provider:'Novita'}])assert.throws(()=>verifyResponse(200,response));
console.log('PASS free-only routes, privacy/price drift refusal, layered roles, quota bounds, paid extras stripping and cost/provider receipts');
