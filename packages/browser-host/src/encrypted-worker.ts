import initWasm, { BrowserVault, authored_sync_example, inspect_package } from 'needware-wasm-runtime';
import { openVaultStore, type EncryptedVaultStore } from './vault-store';
import { DurableSyncSession } from './sync-journal';
import type { EncryptedCommand, EncryptedLoaded, EncryptedEntry } from './encrypted-protocol';
import type { PackageInfo, WorkerReply } from './protocol';
import { requireSupported } from '../../renderer/src/registry';
import { DocumentRelay, RelayFailure, type PreparedImport } from './relay-client';
let proposal: { document: string; value: PreparedImport; info: PackageInfo } | undefined;
let store: EncryptedVaultStore; let vault: BrowserVault | undefined;
let account: string | undefined; let rootGeneration = 0;
let session: DurableSyncSession | undefined; let current: EncryptedEntry | undefined; let instance = '';
const ready = (async () => { await initWasm({ module_or_path: '/wasm/needware_wasm_bg.wasm' }); store = await openVaultStore(); })();
function info(bytes: Uint8Array): PackageInfo {
  const value = JSON.parse(inspect_package(bytes)) as PackageInfo;
  for (const screen of value.application.screens) requireSupported(screen.root);
  if (value.application.capabilities.some(cap => cap.kind !== 'storage' && cap.kind !== 'collaboration')) throw new Error('This encrypted host currently supports storage and collaboration applications only.');
  return value;
}
async function openVault(id: string): Promise<void> {
  if (id === account && vault) return;
  proposal?.value.close(); proposal = undefined;
  await session?.close(); session = undefined; current = undefined; vault?.free(); vault = undefined; account = undefined;
  const root = await store.load(id);
  if (!root) throw new Error('Set up encrypted storage in your account before opening encrypted applications.');
  try { vault = BrowserVault.from_local_backup(root.bytes); } finally { root.bytes.fill(0); }
  if (!vault.enrolled() || JSON.parse(vault.account_context()).account !== id) { vault.free(); vault = undefined; throw new Error('Approve or recover this device in your account first.'); }
  account = id; rootGeneration = root.generation;
}
async function activate(next: DurableSyncSession, entry: EncryptedEntry): Promise<EncryptedLoaded> {
  const view = JSON.parse(next.view()); await session?.close(); session = next; current = entry; instance = crypto.randomUUID();
  return { ...entry, instance, view, pendingUploads: next.pending().length, cloudEnabled: next.cloudEnabled(),epochPending:Boolean(next.cloudEpochIntent()),isOwner:JSON.parse(next.binding()).document.account===JSON.parse(vault!.account_context()).account };
}
async function execute(command: EncryptedCommand): Promise<unknown> {
  await ready; await openVault(command.account);
  if (!vault) throw new Error('Trusted device unavailable');
  switch (command.kind) {
    case 'example': return authored_sync_example();
    case 'inspect': return info(command.bytes);
    case 'collaboration-identity': return {format:'needware-collaboration-device-v1',certificate:JSON.parse(vault.device_certificate())};
    case 'cloud-list': return new DocumentRelay(vault).list();
    case 'preview-cloud': {
      if(!command.consent)throw new Error('Document owner review is required');
      proposal?.value.close();proposal=undefined;
      const relay=new DocumentRelay(vault);const owned=(await relay.list()).find(entry=>entry.id===command.document);
      if(!owned)throw new Error('Cloud document unavailable');
      const own=(owned.binding as {document:{account:string}}).document.account===command.account;
      if(own)await relay.recoverOwnerGrant(command.document);
      const pin=own?vault.account_authority():command.pin;const ownerEpoch=own?JSON.parse(vault.account_context()).epoch:command.ownerEpoch;
      if(!pin||!ownerEpoch)throw new Error('Use the document invitation to verify its owner before importing');
      const value=await relay.prepareImport(store.documents,command.account,rootGeneration,command.document,pin,ownerEpoch,true);
      try{const inspected=value.inspect(info);proposal={document:command.document,value,info:inspected};return {document:command.document,info:inspected};}
      catch(error){value.close();throw error;}
    }
    case 'accept-cloud':{
      if(!command.consent||!proposal||proposal.document!==command.document)throw new Error('Review this cloud package before importing');
      const review=proposal;proposal=undefined;
      try{return await activate(await review.value.commit(),{document:review.document,info:review.info});}finally{review.value.close();}
    }
    case 'cancel-cloud':proposal?.value.close();proposal=undefined;return null;
    case 'sync':{
      if(!session||command.instance!==instance)throw new Error('Application instance is closed or stale');
      const result=await new DocumentRelay(vault).synchronize(session);return {view:JSON.parse(session.view()),pendingUploads:result.pending,more:result.more,cloudEnabled:session.cloudEnabled(),epochPending:Boolean(session.cloudEpochIntent())};
    }
    case 'epoch-state':if(!session||command.instance!==instance)throw new Error('Application instance is closed or stale');return {epochPending:Boolean(session.cloudEpochIntent())};
    case 'rotate-epoch':case 'cancel-epoch':{
      if(!session||command.instance!==instance)throw new Error('Application instance is closed or stale');const relay=new DocumentRelay(vault);
      if(command.kind==='rotate-epoch')await relay.rotateEpoch(session,command.consent);else await relay.cancelEpoch(session);
      return {view:JSON.parse(session.view()),pendingUploads:session.pending().length,cloudEnabled:session.cloudEnabled(),epochPending:Boolean(session.cloudEpochIntent())};
    }
    case 'share':{
      if(!session||!current||command.instance!==instance||!command.consent)throw new Error('Review document sharing first');
      if(session.cloudEpochIntent())throw new Error('Complete or cancel key rotation before sharing');
      const recipient=JSON.parse(command.certificate);
      const offer=JSON.parse(vault.offer_document(current.document,command.certificate,JSON.stringify(recipient.context),recipient.authority.map((byte:number)=>byte.toString(16).padStart(2,'0')).join(''),command.write,true));
      const relay=new DocumentRelay(vault);await relay.synchronize(session);
      await relay.request({action:'grant',document:current.document,recipient,membership:offer.membership,key_envelope:{kind:'offer',value:offer}});
      const bound=JSON.parse(session.binding());return {format:'needware-document-invitation-v1',document:current.document,context:bound.document,authority:vault.account_authority(),ownerEpoch:JSON.parse(vault.account_context()).epoch,role:command.write?'write':'read'};
    }
    case 'list': {
      const entries: EncryptedEntry[] = [];
      for (const document of await store.documents.list(command.account)) entries.push({ document, info: await DurableSyncSession.inspect(store.documents, command.account, document, info) });
      return entries;
    }
    case 'create': {
      if (!command.consent) throw new Error('Review the application and permissions first');
      const inspected = info(command.bytes);
      const collections = [...new Set(inspected.application.capabilities.flatMap(cap => cap.kind === 'storage' && cap.synchronized ? cap.collections : []))].sort();
      const scope = JSON.stringify({ values: [], collections });
      const original = vault.start_document(command.bytes, crypto.randomUUID(), scope, 1, true);
      const document = JSON.parse(original.binding()).document.document;
      try {
        const next = await DurableSyncSession.create(store.documents, vault, command.bytes, original, { account: command.account, rootGeneration, scope, ownerEpoch: JSON.parse(vault.account_context()).epoch, authority: vault.account_authority(), roster: JSON.stringify([JSON.parse(original.membership())]) });
        return await activate(next, { document, info: inspected });
      } catch (error) { original.free(); vault.forget_document(document); throw error; }
    }
    case 'open': {
      const next = await DurableSyncSession.open(store.documents, vault, command.account, command.document, command.consent);
      const bytes = next.packageBytes();
      try { return await activate(next, { document: command.document, info: info(bytes) }); }
      catch (error) { await next.close(); throw error; } finally { bytes.fill(0); }
    }
    case 'dispatch': {
      if (!session || !current || command.instance !== instance) throw new Error('Application instance is closed or stale. Reopen it.');
      await session.dispatch(JSON.stringify({ action: command.action, values: command.values, now: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
      return { view: JSON.parse(session.view()), pendingUploads: session.pending().length };
    }
    case 'export-package': case 'export-state': {
      if (!session || command.instance !== instance) throw new Error('Application instance is closed or stale');
      return command.kind === 'export-package' ? session.packageBytes() : session.snapshot();
    }
    case 'delete': {
      const before = await store.documents.load(command.account, command.document); if (!before) return null; before.bytes.fill(0);
      await store.documents.remove(command.account, command.document, before.generation, before.rootGeneration);
      vault.forget_document(command.document);
      if (current?.document === command.document) { await session?.close(); session = undefined; current = undefined; instance = ''; }
      return null;
    }
  }
}
let queue: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<{ id: number; command: EncryptedCommand }>) => {
  const { id, command } = event.data;
  queue = queue.then(async () => {
    try { self.postMessage({ id, ok: true, data: await execute(command) } satisfies WorkerReply); }
    catch (error) { self.postMessage({ id, ok: false, error: String(error), ...(error instanceof RelayFailure?{status:error.status,retryAfter:error.retryAfter}:{}) } satisfies WorkerReply); }
  });
};
