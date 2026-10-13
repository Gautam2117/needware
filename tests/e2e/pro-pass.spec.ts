import {test,expect} from './fixtures';
test.use({serviceWorkers:'block'});
for(const live of [false,true])test(`annual checkout re-reviews exact price and duration before ${live?'production':'sandbox'} dispatch`,async({page})=>{
 const plans=[{id:'needware_pro_30_days',amount:49900,duration_days:30},{id:'needware_pro_365_days',amount:499000,duration_days:365}].map(plan=>({...plan,currency:'inr',interval:'once',automatic_renewal:false,livemode:live}));
 const account='10000000-0000-4000-8000-000000000001';let requestBody:Record<string,unknown>|undefined;
 await page.route('**/api/auth/get-session**',route=>route.fulfill({json:{session:{id:'session-fixture',userId:account,expiresAt:'2099-01-01T00:00:00Z'},user:{id:account,name:'Local fixture',email:'fixture@needware.invalid',emailVerified:true}}}));
 await page.route('https://sdk.cashfree.com/js/v3/cashfree.js',route=>route.fulfill({contentType:'application/javascript',body:'window.Cashfree=options=>({checkout:async request=>{window.__sandboxCheckout={options,request};return {};}});'}));
 await page.route('**/api/billing',async route=>{
  if(route.request().method()==='POST'){requestBody=route.request().postDataJSON();await route.fulfill({json:{provider:'cashfree_once',livemode:live,session:'session_authored_annual_fixture'}});return;}
  await route.fulfill({json:{provider:'cashfree_once',configured:true,checkout_available:true,price:plans[0],prices:plans,checkout:null,account:null,usage:{plan:'free',creation_hold:false,quota:{daily:3,monthly:20,budget:10000000},resets_at:'2026-11-01T00:00:00Z'}}});
 });
 await page.goto('/billing');await expect(page.getByRole('heading',{name:'₹499 · 30 days',exact:true})).toBeVisible();
 await page.getByLabel('10-digit Indian mobile number').fill('9900000000');
 const consent=page.getByRole('checkbox',{name:/I reviewed/});await consent.check();await expect(consent).toBeChecked();
 await page.getByLabel('Pro access period').selectOption(plans[1].id);
 await expect(page.getByRole('heading',{name:'₹4,990 · 365 days',exact:true})).toBeVisible();await expect(consent).not.toBeChecked();
 await expect(page.getByRole('button',{name:'Continue to Cashfree',exact:true})).toBeDisabled();
 await consent.check();await page.getByRole('button',{name:'Continue to Cashfree',exact:true}).click();
 await expect.poll(()=>requestBody).toMatchObject({action:'checkout',price:plans[1],phone:'9900000000',consent:true});
 await expect.poll(()=>page.evaluate(()=>Boolean((window as unknown as {__sandboxCheckout?:unknown}).__sandboxCheckout))).toBe(true);
 const sdk=await page.evaluate(()=>(window as unknown as {__sandboxCheckout:{options:unknown;request:unknown}}).__sandboxCheckout);
 expect(sdk).toEqual({options:{mode:live?'production':'sandbox'},request:{paymentSessionId:'session_authored_annual_fixture',redirectTarget:'_self'}});
});
