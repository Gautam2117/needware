import {accountRequest,canonicalBody,cloudFailure,cloudResponse,CloudError} from '../../../../../lib/cloud-request';
import {object,uuid} from '../../../../../lib/vault-proof';
import {getGenerationJob,cancelGenerationJob,generationSummary,generationRecipient,GenerationFailure} from '../../../../../lib/generation-store';
export const runtime='nodejs';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{
  const {session,pool}=await accountRequest(request),job=await getGenerationJob(pool,session.user.id,uuid((await params).id));
  if(new URL(request.url).searchParams.get('result')==='1'){
    if(job.state!=='succeeded'||!job.result_ciphertext)throw new CloudError(409,'Creation result is not ready');
    if(job.finished_at&&new Date(job.finished_at).getTime()<Date.now()-30*86400000)throw new CloudError(410,'Creation result expired after 30 days; open your imported encrypted application');
    const client=await pool.connect();try{await client.query('BEGIN');await generationRecipient(client,session.user.id,job.recipient);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    return cloudResponse({job:job.id,metadata:job.result_metadata,ciphertext:job.result_ciphertext.toString('base64'),digest:job.package_digest});
  }return cloudResponse({job:generationSummary(job)});
}catch(error){return error instanceof GenerationFailure?cloudResponse({message:error.message},error.status):cloudFailure(error);}}
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{
  const {session,pool}=await accountRequest(request),payload=object(await canonicalBody(request),['action']);if(payload.action!=='cancel')throw new CloudError(400,'Invalid creation action');
  return cloudResponse({job:generationSummary(await cancelGenerationJob(pool,session.user.id,uuid((await params).id)))},202);
}catch(error){return error instanceof GenerationFailure?cloudResponse({message:error.message},error.status):cloudFailure(error);}}
