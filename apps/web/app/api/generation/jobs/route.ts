import canonicalize from 'canonicalize';
import {accountRequest,canonicalBody,cloudFailure,cloudResponse,CloudError} from '../../../../lib/cloud-request';
import {certificate,object,uuid} from '../../../../lib/vault-proof';
import {generationProvider} from '../../../../lib/generation-provider';
import {createGenerationJob,generationSummary,generationUsage,GenerationFailure,type GenerationJob} from '../../../../lib/generation-store';
export const runtime='nodejs';
export async function GET(request:Request){try{
  const {session,pool}=await accountRequest(request),jobs=await pool.query<GenerationJob>('SELECT * FROM needware_generation_job WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT 64',[session.user.id]);
  return cloudResponse({jobs:jobs.rows.map(generationSummary),usage:await generationUsage(pool,session.user.id)});
}catch(error){return error instanceof GenerationFailure?cloudResponse({message:error.message},error.status):cloudFailure(error);}}
export async function POST(request:Request){try{
  const {session,pool}=await accountRequest(request);if(process.env.NEEDWARE_HOSTED_GENERATION!=='1')throw new CloudError(503,'Hosted creation is not configured');
  const payload=object(await canonicalBody(request,96*1024),['id','prompt','recipient','provider','consent']);
  if(payload.consent!==true||typeof payload.prompt!=='string')throw new CloudError(400,'Review the generation recipient before creation');
  const production=new URL(process.env.BETTER_AUTH_URL!).protocol==='https:',provider=await generationProvider(production);
  if(canonicalize(provider)!==canonicalize(payload.provider))throw new CloudError(409,'Generation provider or policy changed; review it again');
  const job=await createGenerationJob(pool,session.user.id,uuid(payload.id),payload.prompt,certificate(payload.recipient,session.user.id),provider,provider.max_cost_microusd);
  return cloudResponse({job:generationSummary(job)},202);
}catch(error){return error instanceof GenerationFailure?cloudResponse({message:error.message},error.status):cloudFailure(error);}}
