import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compilerFailureCode} from './compiler-failure.mjs';
const fail=(code,message='Safe generic error.')=>({kind:'error',code,message});
test('returns safe allowlisted compiler failures without exposing provider text',()=>{
 for(const [code,expected] of Object.entries({
  invalid_definition:'INVALID_DEFINITION',unsupported_intent:'UNSUPPORTED_INTENT',provider_refused:'PROVIDER_REFUSED',
  provider_rate_limited:'PROVIDER_RATE_LIMITED',provider_unavailable:'PROVIDER_UNAVAILABLE',
  generation_timeout:'GENERATION_TIMEOUT',generation_limit:'GENERATION_LIMIT',
  generation_disabled:'PROVIDER_UNAVAILABLE',generation_cancelled:'CANCELLED'
 })) assert.equal(compilerFailureCode(fail(code,'sensitive input should not be copied')),expected);
});
test('fails closed on malformed and unrecognized messages',()=>{
 for(const invalid of [null,{},[],{kind:'error',code:12,message:'x'},fail('invalid_definition',2),
  {...fail('invalid_definition'),recipient:'unauthorized'},fail('invalid_definition','x'.repeat(1025))]){
  assert.equal(compilerFailureCode(invalid),'INVALID_COMPILER_MESSAGE');
 }
 assert.equal(compilerFailureCode(fail('__proto__')),'COMPILATION_FAILED');
 assert.equal(compilerFailureCode(fail('future_unknown_error')),'COMPILATION_FAILED');
});
