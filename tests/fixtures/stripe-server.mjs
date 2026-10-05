// Authored Stripe SDK HTTP contract fixture. No Stripe account, card or money is used.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
const customers=new Map(),subscriptions=new Map(),invoices=new Map(),payments=new Map(),intents=new Map(),charges=new Map(),disputes=new Map(),warnings=new Map(),idempotency=new Map();
let serial=0,requests=0,failedDeletes=0,lostCheckout=false;const price={id:'price_needwarePro',object:'price',active:true,livemode:false,type:'recurring',recurring:{interval:'month',interval_count:1},billing_scheme:'per_unit',unit_amount:2500,currency:'usd'};
const list=data=>({object:'list',data,has_more:false,url:'/fixture'}),send=(response,status,value)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
function settle(customer,options={}){
  if(!customers.has(customer))throw Error('Unknown fixture customer');const suffix=customer.slice(4),subscription=`sub_${suffix}`,item=`si_${suffix}`,invoice=`in_${suffix}`,intent=`pi_${suffix}`,charge=`ch_${suffix}`,end=Math.floor(Date.now()/1000)+(options.expired?-3600:28*86400),paid=options.paid!==false;
  const configuredPrice={...price,id:options.wrong_price?'price_other':price.id};
  subscriptions.set(customer,{id:subscription,object:'subscription',customer,status:options.status??'active',livemode:false,items:list([{id:item,object:'subscription_item',price:configuredPrice,quantity:options.quantity??1,current_period_end:end}]),latest_invoice:invoice});
  invoices.set(invoice,{id:invoice,object:'invoice',customer:options.wrong_customer?'cus_foreign':customer,livemode:false,status:paid?'paid':'open',amount_paid:paid?2500:0,amount_remaining:paid?0:2500,currency:'usd',parent:{type:'subscription_details',subscription_details:{subscription:options.wrong_subscription?'sub_foreign':subscription}},lines:list([{id:`il_${suffix}`,quantity:1,pricing:{type:'price_details',price_details:{price:configuredPrice.id}},parent:{type:'subscription_item_details',subscription_item_details:{subscription_item:item}},period:{end}}])});
  payments.set(invoice,options.missing_payments?[]:[{id:`inpay_${suffix}`,object:'invoice_payment',invoice,status:'paid',livemode:false,currency:'usd',amount_paid:2500,payment:{type:'payment_intent',payment_intent:intent}}]);
  charges.set(charge,{id:charge,object:'charge',customer,livemode:false,status:'succeeded',paid:true,amount:2500,currency:'usd',amount_refunded:options.refund?2500:0,refunded:Boolean(options.refund),disputed:Boolean(options.disputed),fraud_details:options.fraud?{stripe_report:'fraudulent'}:{}});
  intents.set(intent,{id:intent,object:'payment_intent',customer,livemode:false,status:'succeeded',latest_charge:charge});
  disputes.set(charge,options.disputed?[{id:`dp_${suffix}`,object:'dispute',charge,status:options.dispute_status??'needs_response'}]:[]);warnings.set(charge,options.warning?[{id:`issfr_${suffix}`,object:'radar.early_fraud_warning',charge,actionable:true}]:[]);
  return {customer,subscription,invoice,charge,dispute:`dp_${suffix}`,warning:`issfr_${suffix}`};
}
const server=createServer(async(request,response)=>{try{
  const url=new URL(request.url,'http://127.0.0.1'),chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>256*1024){send(response,413,{});return;}chunks.push(chunk);}const text=Buffer.concat(chunks).toString(),params=new URLSearchParams(text),path=url.pathname;
  if(path.startsWith('/fixture/')){
    if(request.headers['x-fixture-token']!==process.env.NEEDWARE_BILLING_FIXTURE_TOKEN){send(response,403,{});return;}
    if(path==='/fixture/state'){const input=JSON.parse(text),result=settle(input.customer,input.options);send(response,200,result);return;}
    if(path==='/fixture/delete-failure'){failedDeletes=1;send(response,200,{});return;}
    if(path==='/fixture/checkout-failure'){lostCheckout=true;send(response,200,{});return;}
    if(path==='/fixture/stats'){send(response,200,{requests,customers:[...customers.values()].map(value=>({id:value.id,deleted:value.deleted??false})),idempotency_count:idempotency.size});return;}
    send(response,404,{});return;
  }
  if(request.headers.authorization!==`Bearer ${process.env.STRIPE_SECRET_KEY}`||request.headers['stripe-version']!=='2026-09-30.endive'){send(response,401,{error:{message:'Fixture authentication/version rejected',type:'authentication_error'}});return;}
  requests++;const key=request.headers['idempotency-key'],digest=createHash('sha256').update(`${request.method}:${path}:${text}`).digest('hex');
  if(key&&idempotency.has(key)){const previous=idempotency.get(key);if(previous.digest!==digest){send(response,400,{error:{type:'idempotency_error',message:'Fixture idempotency mismatch'}});return;}send(response,200,previous.result);return;}
  let result;
  if(request.method==='GET'&&path==='/v1/account')result={id:'acct_needwareFixture',object:'account'};
  else if(request.method==='GET'&&path===`/v1/prices/${price.id}`)result=price;
  else if(request.method==='POST'&&path==='/v1/customers'){const id=`cus_fixture${++serial}`;result={id,object:'customer',livemode:false,email:params.get('email'),metadata:{needware_account:params.get('metadata[needware_account]')}};customers.set(id,result);}
  else if(request.method==='GET'&&path.startsWith('/v1/customers/'))result=customers.get(path.split('/').at(-1));
  else if(request.method==='DELETE'&&path.startsWith('/v1/customers/')){if(failedDeletes){failedDeletes--;send(response,503,{error:{type:'api_error',message:'Authored deletion interruption'}});return;}const id=path.split('/').at(-1);result={id,object:'customer',deleted:true};customers.set(id,result);subscriptions.delete(id);}
  else if(request.method==='GET'&&path==='/v1/subscriptions'){const value=subscriptions.get(url.searchParams.get('customer'));result=list(value?[value]:[]);}
  else if(request.method==='POST'&&path==='/v1/checkout/sessions'){const id=`cs_test_fixture${++serial}`,customer=params.get('customer');if(params.get('line_items[0][price]')!==price.id||params.get('mode')!=='subscription'){send(response,400,{error:{type:'invalid_request_error',message:'Fixture checkout policy mismatch'}});return;}result={id,object:'checkout.session',customer,livemode:false,mode:'subscription',expires_at:Number(params.get('expires_at')),url:`https://checkout.stripe.com/c/pay/${id}`};}
  else if(request.method==='POST'&&path==='/v1/billing_portal/sessions')result={id:`bps_fixture${++serial}`,object:'billing_portal.session',customer:params.get('customer'),url:'https://billing.stripe.com/p/session/fixture'};
  else if(request.method==='GET'&&path.startsWith('/v1/invoices/'))result=invoices.get(path.split('/').at(-1));
  else if(request.method==='GET'&&path==='/v1/invoice_payments')result=list(payments.get(url.searchParams.get('invoice'))??[]);
  else if(request.method==='GET'&&path.startsWith('/v1/payment_intents/')){const value=intents.get(path.split('/').at(-1));result=value?{...value,latest_charge:charges.get(value.latest_charge)}:undefined;}
  else if(request.method==='GET'&&path.startsWith('/v1/charges/'))result=charges.get(path.split('/').at(-1));
  else if(request.method==='GET'&&path==='/v1/disputes')result=list(disputes.get(url.searchParams.get('charge'))??[]);
  else if(request.method==='GET'&&path.startsWith('/v1/disputes/'))result=[...disputes.values()].flat().find(value=>value.id===path.split('/').at(-1));
  else if(request.method==='GET'&&path==='/v1/radar/early_fraud_warnings')result=list(warnings.get(url.searchParams.get('charge'))??[]);
  else if(request.method==='GET'&&path.startsWith('/v1/radar/early_fraud_warnings/'))result=[...warnings.values()].flat().find(value=>value.id===path.split('/').at(-1));
  if(!result){send(response,404,{error:{type:'invalid_request_error',code:'resource_missing',message:'Authored fixture resource unavailable'}});return;}
  if(key)idempotency.set(key,{digest,result});if(lostCheckout&&path==='/v1/checkout/sessions'){lostCheckout=false;send(response,503,{error:{type:'api_error',message:'Authored lost checkout acknowledgement'}});return;}send(response,200,result);
}catch{send(response,400,{error:{type:'invalid_request_error',message:'Authored fixture input rejected'}});}});
server.listen(Number(process.env.NEEDWARE_BILLING_FIXTURE_PORT),'127.0.0.1',()=>console.log('Authored Stripe SDK fixture ready; no real card/payment/provider account'));
