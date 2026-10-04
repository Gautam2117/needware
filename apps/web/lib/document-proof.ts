import canonicalize from 'canonicalize';
import { blake3 } from '@noble/hashes/blake3.js';
import { CloudError } from './cloud-request';
import { object, uuid, publicKey, bytes, checkSignature, context, type Context } from './vault-proof';
export type DocumentContext = { version: 1; kind: 'document_key'; account: string; document: string; epoch: number };
export type Device = { id: string; encryption: number[]; signing: number[] };
export type Membership = { document: DocumentContext; root_epoch: number; authority: number[]; generation: number; device: Device; role: 'read' | 'write'; signature: number[] };
export type Binding = { protocol: 1; document: DocumentContext; application: string; revision: string; schema_epoch: number; schema_digest: string; generation: number };
export type DocumentTransition = { previous: DocumentContext; next: DocumentContext; root: Context; authority: number[]; previous_generation: number; next_generation: number; digests: { previous_binding: number[]; next_binding: number[]; history: number[]; baseline: number[] }; signature: number[] };
export function transition(value: unknown, previous: Binding, next: Binding, owner: Context, authority: Buffer): DocumentTransition {
  const fields = object(value,['previous','next','root','authority','previous_generation','next_generation','digests','signature']);
  const before = documentContext(fields.previous), after = documentContext(fields.next), root = context(fields.root,owner.account);
  const key = publicKey(fields.authority), signature = bytes(fields.signature,64);
  positive(fields.previous_generation);positive(fields.next_generation);
  const digests = object(fields.digests,['previous_binding','next_binding','history','baseline']);
  for(const digest of Object.values(digests))bytes(digest,32);
  const hash = (bound: Binding) => Buffer.from(blake3(Buffer.from(canonicalize(bound)!)));
  if(canonicalize(before)!==canonicalize(previous.document)||canonicalize(after)!==canonicalize(next.document)
    ||canonicalize(root)!==canonicalize(owner)||!authority.equals(Buffer.from(key))
    ||before.account!==owner.account||before.document!==after.document||before.account!==after.account||before.epoch+1!==after.epoch
    ||fields.previous_generation!==previous.generation||fields.next_generation!==next.generation||previous.generation+1!==next.generation
    ||previous.application!==next.application||previous.revision!==next.revision||previous.schema_epoch!==next.schema_epoch||previous.schema_digest!==next.schema_digest
    ||!hash(previous).equals(Buffer.from(digests.previous_binding as number[]))||!hash(next).equals(Buffer.from(digests.next_binding as number[])))throw new CloudError(403,'Document transition does not match its pinned source');
  checkSignature(key,'NEEDWARE-DOCUMENT-TRANSITION-v1',[before,after,root,key,previous.generation,next.generation,digests],signature);
  return fields as DocumentTransition;
}
export function positive(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 4294967295) throw new CloudError(400,'Invalid document epoch'); return Number(value);
}
export function documentContext(value: unknown): DocumentContext {
  const fields = object(value,['version','kind','account','document','epoch']); uuid(fields.account); uuid(fields.document); positive(fields.epoch);
  if (fields.version !== 1 || fields.kind !== 'document_key') throw new CloudError(400,'Invalid document context'); return fields as DocumentContext;
}
export function binding(value: unknown, document: string): Binding {
  const fields = object(value,['protocol','document','application','revision','schema_epoch','schema_digest','generation']);
  const ctx = documentContext(fields.document); uuid(fields.application); uuid(fields.revision); positive(fields.schema_epoch); positive(fields.generation);
  if (fields.protocol !== 1 || ctx.document !== document || typeof fields.schema_digest !== 'string' || !/^[0-9a-f]{64}$/.test(fields.schema_digest)) throw new CloudError(400,'Invalid document binding');
  return fields as Binding;
}
export function membership(value: unknown, expected: Binding, authority: Buffer, rootEpoch: number): Membership {
  const fields = object(value,['document','root_epoch','authority','generation','device','role','signature']);
  const ctx = documentContext(fields.document); const key = publicKey(fields.authority); const device = object(fields.device,['id','encryption','signing']);
  uuid(device.id); publicKey(device.encryption); publicKey(device.signing);
  const signature = bytes(fields.signature,64);
  if (canonicalize(ctx) !== canonicalize(expected.document) || fields.generation !== expected.generation || fields.root_epoch !== rootEpoch
      || !authority.equals(Buffer.from(key)) || !['read','write'].includes(String(fields.role))) throw new CloudError(403,'Document grant does not match the pinned owner');
  checkSignature(key,'NEEDWARE-DOCUMENT-MEMBERSHIP',[ctx,rootEpoch,key,expected.generation,device,fields.role],signature);
  return fields as Membership;
}
export function ciphertext(value: unknown, min: number, max: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(max/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new CloudError(400,'Invalid ciphertext encoding');
  const decoded = Buffer.from(value,'base64');
  if (decoded.length < min || decoded.length > max || decoded.toString('base64') !== value) throw new CloudError(400,'Ciphertext size limit'); return decoded;
}
