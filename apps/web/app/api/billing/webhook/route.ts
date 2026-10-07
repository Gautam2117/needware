import {authResources} from '../../../../lib/auth-options';
import {billingConfig,BillingFailure} from '../../../../lib/billing-config';
import {enqueueBillingEvent} from '../../../../lib/billing-store';
import {cloudResponse,cloudFailure} from '../../../../lib/cloud-request';
import {billingProvider} from '../../../../lib/billing-policy';
import {cashfreeConfig,verifyCashfreeWebhook} from '../../../../lib/cashfree-client';
import {enqueueCashfreeEvent} from '../../../../lib/cashfree-store';
export const runtime='nodejs';
export async function POST(request:Request){try{
  if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')return cloudResponse({message:'JSON billing event required'},415);
  if(billingProvider()==='cashfree'){
    const config=cashfreeConfig(),{pool}=authResources(),reader=request.body?.getReader();if(!reader)return cloudResponse({message:'Billing event required'},400);
    const chunks:Uint8Array[]=[];let size=0;
    for(;;){const value=await reader.read();if(value.done)break;size+=value.value.length;if(size>256*1024){await reader.cancel();return cloudResponse({message:'Billing event size limit'},413);}chunks.push(value.value);}
    const body=Buffer.concat(chunks);try{await enqueueCashfreeEvent(pool,verifyCashfreeWebhook(config,body,request.headers.get('x-webhook-timestamp')??'',request.headers.get('x-webhook-signature')??''),config);}finally{body.fill(0);}
    return cloudResponse({received:true});
  }
  const config=billingConfig(),{pool}=authResources(),signature=request.headers.get('stripe-signature');if(!signature||signature.length>2048)return cloudResponse({message:'Billing signature required'},400);
  const times=signature.split(',').filter(part=>part.startsWith('t='));if(times.length!==1||!/^t=[0-9]{1,12}$/.test(times[0])||Math.abs(Math.floor(Date.now()/1000)-Number(times[0].slice(2)))>300)return cloudResponse({message:'Billing signature timestamp rejected'},400);
  const reader=request.body?.getReader();if(!reader)return cloudResponse({message:'Billing event required'},400);const chunks=[];let size=0;
  for(;;){const value=await reader.read();if(value.done)break;size+=value.value.length;if(size>256*1024){await reader.cancel();return cloudResponse({message:'Billing event size limit'},413);}chunks.push(value.value);}
  const body=Buffer.concat(chunks);let event;try{event=config.stripe.webhooks.constructEvent(body,signature,config.secret,300);}catch{return cloudResponse({message:'Billing signature rejected'},400);}finally{body.fill(0);}
  if(event.account)return cloudResponse({message:'Connected-account billing is not supported'},400);
  // No event payload, payment details, email or credentials are stored or logged.
  await enqueueBillingEvent(pool,event,config.live,config.account);return cloudResponse({received:true});
}catch(error){return error instanceof BillingFailure?cloudResponse({message:error.message},error.status):cloudFailure(error);}}
