// A navigation can finish after the worker's activation-time clients.claim().
// Ask the installed worker to claim this fully loaded client without skipping
// a waiting update or changing the runtime version selected for this page.
export async function registerOfflineShell(): Promise<void> {
  if(process.env.NODE_ENV!=='production'||!('serviceWorker' in navigator))return;
  await navigator.serviceWorker.register('/sw.js');
  const registration=await navigator.serviceWorker.ready;
  if(!navigator.serviceWorker.controller)registration.active?.postMessage({kind:'needware-claim-ready-client'});
}
