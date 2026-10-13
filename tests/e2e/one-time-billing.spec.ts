import {test,expect} from './fixtures';
import AxeBuilder from '@axe-core/playwright';
test.use({serviceWorkers:'block'});
test('one-time checkout binds consent and retries, never grants Pro from SDK return',async({page})=>{
 const posts:Record<string,unknown>[]=[];
 await page.route('**/api/auth/get-session**',route=>route.fulfill({json:{session:{id:'fixture-session',userId:'10000000-0000-4000-8000-000000000001',expiresAt:'2099-01-01T00:00:00Z'},user:{id:'10000000-0000-4000-8000-000000000001',name:'Billing fixture',email:'billing@example.invalid',emailVerified:true}}}));
 await page.route('https://sdk.cashfree.com/js/v3/cashfree.js',route=>route.fulfill({contentType:'application/javascript',body:'window.Cashfree=()=>({checkout:async options=>{window.__oneTimeCheckout=options;return {};}});'}));
 const data={provider:'cashfree_once',configured:true,checkout_available:true,price:{id:'needware_pro_30_days',amount:49900,currency:'inr',interval:'once',duration_days:30,automatic_renewal:false,livemode:false},checkout:null,account:{status:'free',paid_until:null,has_customer:true},usage:{plan:'free',creation_hold:false,quota:{daily:3,monthly:20,budget:0},resets_at:'2026-11-01T00:00:00Z'}};
 await page.route('**/api/billing',route=>{if(route.request().method()==='GET')return route.fulfill({json:data});posts.push(route.request().postDataJSON());return route.fulfill({json:{provider:'cashfree_once',livemode:false,session:'session_authored_one_time_checkout'}});});
 await page.goto('/billing');const button=page.getByRole('button',{name:'Continue to Cashfree',exact:true}),phone=page.getByLabel('10-digit Indian mobile number'),consent=page.getByLabel(/I reviewed ₹499/);
 await expect(page.getByText('No automatic renewal.',{exact:true})).toBeVisible();await expect(button).toBeDisabled();await phone.fill('9900000000');await consent.check();await expect(button).toBeEnabled();
 await button.click();await expect.poll(()=>posts.length).toBe(1);expect(posts[0].price).toEqual(data.price);await expect(page.getByRole('heading',{name:'Free',exact:true})).toBeVisible();
 await button.click();await expect.poll(()=>posts.length).toBe(2);expect(posts[1].id).toBe(posts[0].id);
 await phone.fill('9900000001');await expect(consent).not.toBeChecked();await expect(button).toBeDisabled();
 data.checkout_available=false;Object.assign(data.usage,{availability:{state:'daily_limit',resets_at:'2026-10-15T00:00:00Z'}});await page.getByRole('button',{name:'Verify payment and access'}).click();await expect(page.getByText(/today’s creation capacity is used/)).toBeVisible();await expect(button).toBeDisabled();
 Object.assign(data,{launch_capacity:{limit:3,remaining:0,available:false}});await page.getByRole('button',{name:'Verify payment and access'}).click();await expect(page.getByText(/initial paid pilot is full/)).toBeVisible();await expect(button).toBeDisabled();
});
test('public pricing and policies are accessible without an account and fit narrow screens',async({page},info)=>{
 await page.setViewportSize({width:320,height:740});
 for(const path of ['/pricing','/refunds','/terms','/privacy']){await page.goto(path);await expect(page.locator('#main')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(results.violations.map(v=>v.id)).toEqual([]);
 }
 await page.goto('/pricing');await expect(page.getByRole('heading',{name:'Pro · ₹499 for 30 days'})).toBeVisible();await expect(page.getByText(/Checkout availability is checked live before payment/)).toBeVisible();await page.screenshot({path:info.outputPath('pricing-mobile.png'),fullPage:true});
});
