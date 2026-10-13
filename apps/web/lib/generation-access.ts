// A bounded operator canary expires closed; removing every canary field opens normal admission.
export function generationAllowed(account:string,env:Record<string,string|undefined>=process.env,now=Date.now()){
 if(env.NEEDWARE_HOSTED_GENERATION!=='1')return false;
 const fields=[env.NEEDWARE_GENERATION_CANARY_ACCOUNT,env.NEEDWARE_GENERATION_CANARY_STARTED_AT,env.NEEDWARE_GENERATION_CANARY_UNTIL];
 if(!fields.some(Boolean))return true;
 const [owner,startValue,untilValue]=fields,start=Date.parse(startValue??''),until=Date.parse(untilValue??'');
 return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner??'')
  &&account===owner&&(env.NEEDWARE_OPERATOR_ACCOUNTS?.split(',')??[]).includes(account)
  &&Number.isFinite(start)&&Number.isFinite(until)&&start<=now&&until>now&&until-start>0&&until-start<=1800000;
}
