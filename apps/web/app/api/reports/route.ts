import {accountRequest,canonicalBody,cloudFailure,cloudResponse} from '../../../lib/cloud-request';
import {reportApplication} from '../../../lib/operations-store';
export const runtime='nodejs';
export async function POST(request:Request){try{const {session,pool}=await accountRequest(request);return cloudResponse(await reportApplication(pool,session.user.id,await canonicalBody(request,4096)));}catch(error){return cloudFailure(error);}}
