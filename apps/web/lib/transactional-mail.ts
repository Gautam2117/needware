type Message={from:string;to:string;subject:string;text:string};
type SMTP={sendMail:(message:Message)=>Promise<unknown>};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure=()=>Object.assign(new Error('Transactional email delivery failed'),{code:'ERESEND_DELIVERY'});
// Keep the durable outbox and its lease/retry semantics independent of transport.
export async function sendTransactionalMail(smtp:SMTP,message:Message,outbox:string,env:Partial<NodeJS.ProcessEnv>=process.env,request:typeof fetch=fetch){
  if(!env.NEEDWARE_MAIL_TRANSPORT||env.NEEDWARE_MAIL_TRANSPORT==='smtp')return smtp.sendMail(message);
  if(env.NEEDWARE_MAIL_TRANSPORT!=='resend'||!/^re_[A-Za-z0-9_-]{16,256}$/.test(env.RESEND_API_KEY??''))throw failure();
  if(!uuid.test(outbox)||Object.keys(message).some(k=>!['from','to','subject','text'].includes(k))
    ||Object.values(message).some(v=>typeof v!=='string')||/[\r\n]/.test(message.from+message.to+message.subject)
    ||! /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(message.to)||message.to.length>254||message.from.length>320
    ||message.subject.length>254||Buffer.byteLength(message.text)>16384)throw failure();
  try{
    const response=await request('https://api.resend.com/emails',{method:'POST',redirect:'error',
      headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'needware-outbox-'+outbox},
      body:JSON.stringify({...message,to:[message.to]}),signal:AbortSignal.timeout(15000)});
    if(!response.ok){await response.body?.cancel();throw failure();}
    const reader=response.body?.getReader();let body='',size=0;
    if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw failure();}body+=Buffer.from(value).toString('utf8');}
    const result=JSON.parse(body);if(!uuid.test(result?.id??''))throw failure();
    return {messageId:result.id};
  }catch{throw failure();}
}
