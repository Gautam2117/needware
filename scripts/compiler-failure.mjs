// The private compiler returns only allowlisted, non-sensitive failure categories.
// Do not persist provider messages: they may contain rejected prompt fragments.
const codes=Object.freeze({
  invalid_definition:'INVALID_DEFINITION',
  unsupported_intent:'UNSUPPORTED_INTENT',
  provider_refused:'PROVIDER_REFUSED',
  provider_rate_limited:'PROVIDER_RATE_LIMITED',
  provider_unavailable:'PROVIDER_UNAVAILABLE',
  generation_timeout:'GENERATION_TIMEOUT',
  generation_limit:'GENERATION_LIMIT',
  generation_disabled:'PROVIDER_UNAVAILABLE',
  generation_cancelled:'CANCELLED',
});
export function compilerFailureCode(message){
  if(!message||typeof message!=='object'||Array.isArray(message)||
    Object.keys(message).sort().join(',')!=='code,kind,message'||
    message.kind!=='error'||typeof message.code!=='string'||
    typeof message.message!=='string'||message.message.length>1024){
    return 'INVALID_COMPILER_MESSAGE';
  }
  return Object.hasOwn(codes,message.code)?codes[message.code]:'COMPILATION_FAILED';
}
