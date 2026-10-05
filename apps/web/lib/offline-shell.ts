// A navigation can finish after the worker's activation-time clients.claim().
// Ask the installed worker to claim this fully loaded client without skipping
// a waiting update or changing the runtime version selected for this page.
export async function registerOfflineShell(): Promise<void> {
  if(process.env.NODE_ENV!=='production'||!('serviceWorker' in navigator))return;
  await navigator.serviceWorker.register('/sw.js');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const registration=await Promise.race([navigator.serviceWorker.ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Offline shell installation did not finish. Keep this page online and retry.')),30_000);})]).finally(()=>{clearTimeout(timer);});
  // A single claim message can arrive before WebKit exposes the fully navigated
  // client to the worker. Retry only the active worker; never skip a waiting update.
  for(let attempt=0;attempt<40;attempt++){
    if(navigator.serviceWorker.controller)return;
    registration.active?.postMessage({kind:'needware-claim-ready-client'});
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!navigator.serviceWorker.controller)throw Error('Offline shell could not control this page. Keep it online and reload before disconnecting.');
}
