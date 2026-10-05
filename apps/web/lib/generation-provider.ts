import type {ProviderInfo} from '@needware/ir-types/ProviderInfo';
import {privateControlConfig} from './control-config.ts';
import {GenerationFailure} from './generation-store.ts';
export async function boundedBytes(response:Response,limit:number):Promise<Uint8Array>{
  const reader=response.body?.getReader();if(!reader)throw new GenerationFailure(503,'Service response unavailable');const chunks=[];let length=0;
  for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>limit){await reader.cancel();throw new GenerationFailure(503,'Service response size limit');}chunks.push(next.value);}
  return new Uint8Array(Buffer.concat(chunks));
}
export async function generationProvider(production:boolean):Promise<ProviderInfo>{
  const config=privateControlConfig();if(!config)throw new GenerationFailure(503,'Hosted creation is not configured');
  const response=await fetch(new URL('/api/providers',config.endpoint),{headers:config.headers,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new GenerationFailure(503,'Hosted provider unavailable');
  const provider=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBytes(response,32768))).provider;
  const keys=['fixture','kind','model','endpoint','credential_owner','signing_authority','max_cost_microusd','input_microusd_per_million','output_microusd_per_million'];
  if(!provider||Object.keys(provider).sort().join(',')!==keys.sort().join(','))throw new GenerationFailure(503,'Hosted provider policy structure is unavailable');
  if(!provider||typeof provider.fixture!=='boolean'||!['local','open_ai','anthropic','gemini'].includes(provider.kind)||typeof provider.model!=='string'||!provider.model||provider.model.length>200||typeof provider.endpoint!=='string'||provider.endpoint.length>2000||provider.credential_owner!=='installation'||!Number.isSafeInteger(provider.max_cost_microusd)||provider.max_cost_microusd<0||provider.max_cost_microusd>1000000000||!Number.isSafeInteger(provider.input_microusd_per_million)||provider.input_microusd_per_million<0||!Number.isSafeInteger(provider.output_microusd_per_million)||provider.output_microusd_per_million<0||!/^[0-9a-f]{64}$/.test(provider.signing_authority)||production&&provider.fixture)throw new GenerationFailure(503,'Hosted provider policy is unavailable');
  const endpoint=new URL(provider.endpoint);if(production&&endpoint.protocol!=='https:')throw new GenerationFailure(503,'Production providers require HTTPS');return provider as ProviderInfo;
}
