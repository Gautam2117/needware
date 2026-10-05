import {accountRequest,canonicalBody,cloudFailure,cloudResponse} from '../../../lib/cloud-request';
import {authConfigured,authResources} from '../../../lib/auth-options';
import {getAuth} from '../../../lib/auth';
import {object} from '../../../lib/vault-proof';
import {registryList,publishRegistry,removeRegistry} from '../../../lib/registry-store';
import {publicRequest} from '../../../lib/public-request';
export const runtime='nodejs';
export async function GET(request:Request){try{
  if(!authConfigured())return cloudResponse({applications:[]});
  await publicRequest(request,authResources().pool);
  const session=await getAuth().api.getSession({headers:request.headers});
  return cloudResponse({applications:await registryList(authResources().pool,session?.user.emailVerified?session.user.id:undefined)});
}catch(error){return cloudFailure(error);}}
export async function POST(request:Request){try{
  const {session,pool}=await accountRequest(request),payload=await canonicalBody(request,6*1024*1024);
  if(payload&&typeof payload==='object'&&'action' in payload&&payload.action==='delete'){
    const value=object(payload,['action','id','expected_version']);await removeRegistry(pool,session.user.id,String(value.id),Number(value.expected_version));return cloudResponse({deleted:true});
  }
  return cloudResponse({application:await publishRegistry(pool,session.user.id,payload)});
}catch(error){return cloudFailure(error);}}
