// A navigation can finish after the worker's activation-time clients.claim().
// Ask the installed worker to claim this fully loaded client without skipping
// a waiting update or changing the runtime version selected for this page.
export async function registerOfflineShell(): Promise<void> {
  if(process.env.NODE_ENV!=='production'||!('serviceWorker' in navigator))return;
  const registration=await navigator.serviceWorker.register('/sw.js');
  if(!registration)throw Error('Offline support is unavailable on this page. Keep it online and export important data.');
  // WebKit can leave this document's ready promise pending after navigation,
  // even with an activated registration. Claim from that registration directly;
  // activation still requires successful completion of the install/cache event.
  for(let attempt=0;attempt<120&&registration.active?.state!=='activated';attempt++){
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(registration.active?.state!=='activated')throw Error('Offline shell installation did not finish. Keep this page online and retry.');
  // A single claim message can arrive before WebKit exposes the fully navigated
  // client to the worker. Retry only the active worker; never skip a waiting update.
  for(let attempt=0;attempt<40;attempt++){
    if(navigator.serviceWorker.controller)return;
    registration.active?.postMessage({kind:'needware-claim-ready-client'});
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!navigator.serviceWorker.controller)throw Error('Offline shell could not control this page. Keep it online and reload before disconnecting.');
}
