import {timingSafeEqual} from 'node:crypto';
import {authResources} from '../../../../lib/auth-options';
import {cashfreeConfig} from '../../../../lib/cashfree-client';
import {scheduledCashfree} from '../../../../lib/billing-scheduled';
export const runtime='nodejs';
export const maxDuration=28;
export async function POST(request:Request){
  const token=process.env.NEEDWARE_BILLING_DISPATCH_TOKEN,provided=request.headers.get('authorization');
  const headers={'Cache-Control':'no-store'};
  if(process.env.NEEDWARE_BILLING_DISPATCH_MODE!=='scheduled'||!token||!/^[0-9a-f]{64}$/.test(token)||!provided||Buffer.byteLength(provided)!==71||!timingSafeEqual(Buffer.from(provided),Buffer.from('Bearer '+token)))return new Response('Unauthorized',{status:401,headers});
  if(process.env.NEEDWARE_BILLING_MODE!=='cashfree')return Response.json({status:'DISABLED'},{headers});
  if(Number(request.headers.get('content-length')??0)>2)return new Response('Body limit',{status:413,headers});
  const reader=request.body?.getReader();let length=0,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;void reader?.cancel().catch(()=>{});},1000);
  try{
    if(reader)for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>2)return new Response('Body limit',{status:413,headers});}
    clearTimeout(timer);if(timedOut)return new Response('Body timeout',{status:408,headers});
    const result=await scheduledCashfree(authResources().pool.options,cashfreeConfig());
    return Response.json({status:result.ok?'PASS':'FAIL'},{status:result.ok?200:503,headers});
  }catch{return Response.json({status:'FAIL'},{status:503,headers});}
  finally{clearTimeout(timer);await reader?.cancel().catch(()=>{});}
}
