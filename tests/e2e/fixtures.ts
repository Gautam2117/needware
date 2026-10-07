import { test as base, type Page } from '@playwright/test';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
export const test = base.extend<{ offlineServer: { url: string; stop(): Promise<void>;update():void;unavailableClientLookup():void } }>({
  offlineServer: async ({ baseURL }, use) => {
    const upstream = new URL(baseURL ?? 'http://127.0.0.1:3108');
    let revision=0,unavailableClientLookup=false;
    const server = createServer((incoming, outgoing) => {
      const isWorker=incoming.url?.split('?')[0]==='/sw.js'&&incoming.method==='GET';const headers={...incoming.headers,host:upstream.host};if(isWorker){delete headers['if-none-match'];delete headers['if-modified-since'];headers['accept-encoding']='identity';}
      const relay = request({ hostname: upstream.hostname, port: upstream.port, path: incoming.url, method: incoming.method, headers }, response => {
        if(isWorker&&(revision||unavailableClientLookup)){const parts:Buffer[]=[];response.on('data',part=>parts.push(part));response.on('end',()=>{let body=Buffer.concat(parts).toString();if(revision)body=body.replace('const CACHE="needware-',`const CACHE="needware-test-update-${revision}-`);if(unavailableClientLookup)body='(()=>{self.clients.get=async()=>undefined;const claim=self.clients.claim.bind(self.clients);let attempts=0;self.clients.claim=()=>++attempts===1?Promise.resolve():claim();})();\n'+body;const changed={...response.headers,'cache-control':'no-store'};delete changed['content-length'];delete changed.etag;outgoing.writeHead(response.statusCode??502,changed);outgoing.end(body);});return;}
        outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
      });
      relay.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(relay);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
    try { await use({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, stop,update(){revision++;},unavailableClientLookup(){unavailableClientLookup=true;} }); }
    finally { await stop(); }
  },
});
export { expect } from '@playwright/test';
export async function waitForOfflineReady(page: Page): Promise<void> {
  try { await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {timeout:45_000}); }
  catch (error) {
    const status = await page.evaluate(async () => ({
      secure: isSecureContext, online: navigator.onLine,
      registrations: (await navigator.serviceWorker.getRegistrations()).map(registration => ({
        scope: registration.scope, active: registration.active?.state,
        waiting: registration.waiting?.state, installing: registration.installing?.state,
      })),
      caches: await caches.keys(),
    }));
    throw new Error(`Offline cache activation failed: ${JSON.stringify(status)}`, {cause:error});
  }
}
