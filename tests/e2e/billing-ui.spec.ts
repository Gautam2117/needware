import {test,expect} from './fixtures';
// Network-authored UI fixtures; offline behavior has separate real-worker acceptance.
test.use({serviceWorkers:'block'});
import type {Page} from '@playwright/test';
async function billing(page:Page,available=true){
  let posts:Record<string,unknown>[]=[];
  await page.route('**/api/auth/get-session**',route=>route.fulfill({json:{session:{id:'fixture-session',userId:'10000000-0000-4000-8000-000000000001',expiresAt:'2099-01-01T00:00:00Z'},user:{id:'10000000-0000-4000-8000-000000000001',name:'Billing fixture',email:'billing@example.invalid',emailVerified:true}}}));
  await page.route('https://sdk.cashfree.com/js/v3/cashfree.js',route=>route.fulfill({contentType:'application/javascript',body:'window.Cashfree=()=>({subscriptionsCheckout:async options=>{window.__checkout=options;return {};}});'}));
  const data={provider:'cashfree',configured:true,checkout_available:available,price:{id:'needware_pro_monthly_499',amount:49900,currency:'INR',interval:'month',livemode:false},checkout:null,account:{status:'initialized',paid_until:null,has_customer:true},usage:{plan:'free',creation_hold:false,quota:{daily:5,monthly:30,budget:0},resets_at:'2026-11-01T00:00:00Z'}};
  await page.route('**/api/billing',async route=>{
    if(route.request().method()==='GET')return route.fulfill({json:data});
    const value=route.request().postDataJSON();posts.push(value);
    return route.fulfill({json:value.action==='cancel'?{cancelled:true}:{provider:'cashfree',livemode:false,session:'fixture_subscription_session_1234'}});
  });
  await page.goto('/billing');await expect(page.getByRole('heading',{name:/Pro ·/})).toBeVisible();
  return {posts,data};
}
test('valid phone and renewed consent enable checkout; checkout never grants Pro',async({page})=>{
  const {posts}=await billing(page);const button=page.getByRole('button',{name:'Continue to Cashfree checkout'}),phone=page.getByLabel('10-digit Indian mobile number'),consent=page.getByLabel(/I reviewed/);
  await expect(button).toBeDisabled();await phone.fill('987654321');await consent.check();await expect(button).toBeDisabled();
  await phone.fill('9876543210');await expect(consent).not.toBeChecked();await consent.check();await expect(button).toBeEnabled();
  await button.click();await expect.poll(()=>posts.length).toBe(1);expect(posts[0].phone).toBe('9876543210');expect(posts[0].consent).toBe(true);
  await expect(page.getByRole('heading',{name:'Free',exact:true})).toBeVisible();await expect(page.getByText(/Checkout return alone does not activate/)).toBeVisible();
  await button.click();await expect.poll(()=>posts.length).toBe(2);expect(posts[1].id).toBe(posts[0].id);
});
test('activation pause keeps cancellation available and fits narrow screens',async({page})=>{
  await page.setViewportSize({width:320,height:720});const {posts}=await billing(page,false);
  await expect(page.getByText(/New subscriptions are paused while/)).toBeVisible();await expect(page.getByRole('button',{name:'Continue to Cashfree checkout'})).toBeDisabled();
  const cancel=page.getByRole('button',{name:'Cancel subscription'});await expect(cancel).toBeDisabled();await page.getByLabel(/Stop future renewal/).check();await cancel.click();await expect.poll(()=>posts.length).toBe(1);expect(posts[0]).toEqual({action:'cancel',consent:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
test('signed-out billing provides an account link',async({page})=>{
  await page.route('**/api/auth/get-session**',route=>route.fulfill({json:null}));await page.goto('/billing');await expect(page.getByRole('link',{name:'Sign in or create an account'})).toHaveAttribute('href','/account');
});

test('a newly verified price requires fresh consent before checkout',async({page})=>{
  const {data,posts}=await billing(page),consent=page.getByLabel(/I reviewed/),button=page.getByRole('button',{name:'Continue to Cashfree checkout'});
  await page.getByLabel('10-digit Indian mobile number').fill('9876543210');await consent.check();await expect(button).toBeEnabled();
  data.price.amount=50000;await page.getByRole('button',{name:'Refresh verified payment state'}).click();
  await expect(page.getByRole('heading',{name:/Pro · ₹500/})).toBeVisible();await expect(consent).not.toBeChecked();await expect(button).toBeDisabled();expect(posts).toHaveLength(0);
});
