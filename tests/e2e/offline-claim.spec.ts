import {test,expect,waitForOfflineReady} from './fixtures';
test('offline registration claims with ready pending and retries lost requests without forcing a waiting update',async({page,offlineServer})=>{
  offlineServer.unavailableClientLookup();
  await page.addInitScript(()=>{
    const container=navigator.serviceWorker;const getter=Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype,'controller')!.get!;let claims=0;
    Object.defineProperty(container,'ready',{configurable:true,get:()=>new Promise<ServiceWorkerRegistration>(()=>{})});
    const post=ServiceWorker.prototype.postMessage;
    Object.defineProperty(container,'controller',{configurable:true,get(){return claims>=3?getter.call(container):null;}});
    ServiceWorker.prototype.postMessage=function(...args:Parameters<ServiceWorker['postMessage']>){if(args[0]?.kind==='needware-claim-ready-client'){claims++;if(claims<=2)return;}post.apply(this,args);};
  });
  await page.goto(offlineServer.url);await expect(page.getByText('Local runtime ready',{exact:true})).toBeVisible();await waitForOfflineReady(page);await offlineServer.stop();await page.reload();await expect(page.getByText('Local runtime ready',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Try the authored habit tracker',exact:true}).click();await expect(page.getByRole('heading',{name:'Review Habit tracker',exact:true})).toBeVisible();
});
