import {test,expect} from './fixtures';
// Network-authored UI fixtures; offline behavior has separate real-worker acceptance.
test.use({serviceWorkers:'block'});
test('publication review resets when the encrypted application changes and fits mobile',async({page})=>{
  await page.setViewportSize({width:320,height:760});
  await page.route('**/api/auth/get-session**',route=>route.fulfill({json:{user:{id:'fixture-owner',emailVerified:true}}}));
  await page.route('**/api/registry**',route=>route.fulfill({json:{applications:[]}}));
  await page.route('**/api/documents**',route=>route.fulfill({json:{documents:[{id:'first-document',ready:true},{id:'second-document',ready:true}]}}));
  await page.goto('/registry');
  const application=page.getByLabel('Encrypted cloud application'),consent=page.getByLabel('I reviewed the definition and selected visibility'),publish=page.getByRole('button',{name:'Publish application',exact:true});
  await expect(application).toBeVisible();await consent.check();await expect(publish).toBeDisabled();
  await application.selectOption('first-document');await expect(consent).not.toBeChecked();
  await consent.check();await expect(publish).toBeEnabled();
  await application.selectOption('second-document');await expect(consent).not.toBeChecked();await expect(publish).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const offline=page.getByRole('complementary',{name:'Offline support'});await expect(offline.getByRole('alert')).toContainText('Offline access could not be prepared');await expect(offline).not.toContainText('TypeError');await offline.getByRole('button',{name:'Check for updates'}).click();await expect(offline.getByRole('alert')).toContainText('Offline support could not be refreshed');
  const title=await page.getByLabel('Application title').boundingBox(),summary=await page.getByLabel('Application summary').boundingBox();
  expect(title&&summary&&summary.y>=title.y+title.height+20).toBeTruthy();
});
