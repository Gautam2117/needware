import {authConfigured,authResources} from '../../../../lib/auth-options';
import {getAuth} from '../../../../lib/auth';
import {CloudError,cloudFailure,cloudResponse} from '../../../../lib/cloud-request';
import {registryEntry} from '../../../../lib/registry-store';
import {publicRequest} from '../../../../lib/public-request';
export const runtime='nodejs';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{
  if(!authConfigured())throw new CloudError(503,'Registry is not configured');
  await publicRequest(request,authResources().pool);
  const {id}=await params,query=new URL(request.url),session=await getAuth().api.getSession({headers:request.headers});
  const entry=await registryEntry(authResources().pool,id,session?.user.emailVerified?session.user.id:undefined,query.searchParams.get('revision')??undefined);
  if(query.searchParams.get('download')==='1'){
    const result=await authResources().pool.query(`SELECT r.package FROM needware_registry_revision r JOIN needware_registry_entry e ON e.id=r.entry_id
      WHERE r.entry_id=$1 AND r.digest=$2 AND ((e.visibility<>'private' AND NOT e.moderated AND NOT EXISTS(SELECT 1 FROM needware_account_hold h WHERE h.account_id=e.owner_id AND h.active)) OR e.owner_id=$3)`,[entry.id,query.searchParams.get('revision')??entry.current_digest,session?.user.emailVerified?session.user.id:null]);
    if(!result.rows[0]?.package)throw new CloudError(404,'Encrypted definitions require the owner vault and a current grant');
    await publicRequest(request,authResources().pool,result.rows[0].package.length);
    return new Response(result.rows[0].package,{headers:{'Content-Type':'application/vnd.needware.package','Content-Disposition':'attachment; filename="application.need"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  }return cloudResponse({application:{...entry,current_digest:query.searchParams.get('revision')??entry.current_digest}});
}catch(error){return cloudFailure(error);}}
