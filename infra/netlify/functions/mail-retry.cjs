exports.handler=async()=>{
  if(process.env.NEEDWARE_MAIL_DISPATCH_MODE!=='scheduled')return {statusCode:200,body:'Disabled'};
  const origin=new URL(process.env.BETTER_AUTH_URL),token=process.env.NEEDWARE_MAIL_DISPATCH_TOKEN;
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||!/^[0-9a-f]{64}$/.test(token??''))throw Error('Invalid mail dispatch configuration');
  const response=await fetch(new URL('/api/internal/mail',origin),{method:'POST',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw Error('Bounded mail retry unavailable');
  return {statusCode:200,body:'Complete'};
};
