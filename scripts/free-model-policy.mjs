// Synthetic diagnostics only; not a production provider or user consent policy.
import assert from 'node:assert/strict';
export const routes = Object.freeze({
  apodex: Object.freeze({model:'apodex/apodex-1.1-mini:free',tag:'novita/bf16',json:true}),
  ling: Object.freeze({model:'inclusionai/ling-3.0-flash-sante:free',tag:'novita',json:false}),
});
export function roles(profile) {
  assert.ok(['apodex','ling','layered'].includes(profile),'Unknown free diagnostic profile');
  return Object.freeze(profile==='layered'?{intent:routes.apodex,generation:routes.ling,repair:routes.apodex}:
    {intent:routes[profile],generation:routes[profile],repair:routes[profile]});
}
function verifyRoles(selected) {
  assert.deepEqual(Object.keys(selected).sort(),['generation','intent','repair']);
  assert.ok(Object.values(selected).every(route=>route===routes.apodex||route===routes.ling),'Unapproved route');
}
export function verifyEndpoints(rows, selected) {
  verifyRoles(selected);
  assert.ok(Array.isArray(rows),'Missing current zero-retention endpoint list');
  for(const route of new Set(Object.values(selected))) {
    const endpoint=rows.find(row=>row.model_id===route.model&&row.tag===route.tag);
    assert.ok(endpoint,'Approved route is no longer listed as zero retention');
    assert.equal(endpoint.pricing?.prompt,'0');assert.equal(endpoint.pricing?.completion,'0');
    assert.ok(Object.values(endpoint.pricing).every(price=>Number(price)===0),'Nonzero route fee');
    if(route.json)assert.ok(endpoint.supported_parameters.includes('response_format'));
  }
}
export function requestBudget(quota) {
  const allowance=quota?.free_model_daily_requests;
  assert.ok(allowance&&Number.isSafeInteger(allowance.remaining)&&allowance.remaining>0,'Free quota unavailable or exhausted');
  return Math.min(12,allowance.remaining);
}
export function freeRequest(original, selected) {
  verifyRoles(selected);
  assert.equal(original.model,selected.generation.model);
  assert.ok(Array.isArray(original.messages)&&original.messages.length===1);
  const prompt=original.messages[0].content,schema=original.response_format?.json_schema?.schema;
  assert.equal(original.messages[0].role,'user');assert.equal(typeof prompt,'string');
  assert.ok(schema&&schema.type==='object');
  assert.ok(Number.isInteger(original.max_tokens)&&original.max_tokens>0&&original.max_tokens<=8192);
  const role=schema.title==='Intent'?'intent':prompt.endsWith('keep all user requirements.')?'repair':'generation';
  const route=selected[role];
  const body={model:route.model,temperature:original.temperature,max_tokens:original.max_tokens,stream:false,
    messages:[{role:'system',content:'Return a JSON INSTANCE, never a schema. Include exactly the required instance properties and no extra properties.'},
      ...original.messages,{role:'user',content:`Output a JSON instance satisfying this schema; the schema itself is not the answer: ${JSON.stringify(schema)}`}],
    provider:{only:[route.tag],allow_fallbacks:false,require_parameters:true,data_collection:'deny',zdr:true,max_price:{prompt:0,completion:0}},
    reasoning:{enabled:false}};
  if(route.json)body.response_format={type:'json_object'};
  return {role,body};
}
export function verifyResponse(status, response) {
  if(response?.usage)assert.equal(response.usage.cost,0,'Unknown or nonzero cost: stop');
  if(status===200) {
    assert.ok(response?.usage,'Missing successful usage receipt: stop');
    assert.ok(['Novita','NovitaAI'].includes(response.provider),'Unexpected provider: stop');
  }
}
