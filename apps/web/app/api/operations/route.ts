import {accountRequest,canonicalBody,cloudFailure,cloudResponse} from '../../../lib/cloud-request';
import {operationsSummary,operate,retryWorker} from '../../../lib/operations-store';
export const runtime='nodejs';
export async function GET(request:Request){try{const {session,pool}=await accountRequest(request,true);return cloudResponse(await operationsSummary(pool,session.user.id));}catch(error){return cloudFailure(error);}}
export async function POST(request:Request){try{const {session,pool}=await accountRequest(request,true),payload=await canonicalBody(request,4096);return cloudResponse(await ((payload as {action?:unknown})?.action==='retry_worker'?retryWorker:operate)(pool,session.user.id,payload));}catch(error){return cloudFailure(error);}}
