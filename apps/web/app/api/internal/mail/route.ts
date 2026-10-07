import {timingSafeEqual} from 'node:crypto';
import {runMailWorker} from '../../../../../../scripts/mail-worker.mjs';
export const runtime='nodejs';
export async function POST(request:Request){
  const token=process.env.NEEDWARE_MAIL_DISPATCH_TOKEN,provided=request.headers.get('authorization');
  if(process.env.NEEDWARE_MAIL_DISPATCH_MODE!=='scheduled'||!token||!/^[0-9a-f]{64}$/.test(token)||!provided||Buffer.byteLength(provided)!==71||!timingSafeEqual(Buffer.from(provided),Buffer.from('Bearer '+token)))return new Response('Unauthorized',{status:401});
  if(request.headers.get('content-length')&&Number(request.headers.get('content-length'))>2)return new Response('Body limit',{status:413});
  const reader=request.body?.getReader();let length=0;
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>2){await reader.cancel();return new Response('Body limit',{status:413});}}
  try{await runMailWorker({once:true,reuseResources:true,scheduleSeconds:900});return Response.json({status:'PASS'},{headers:{'Cache-Control':'no-store'}});}
  catch{return Response.json({status:'FAIL'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
