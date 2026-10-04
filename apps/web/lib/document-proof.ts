import canonicalize from 'canonicalize';
import { CloudError } from './cloud-request';
import { object, uuid, publicKey, bytes, checkSignature } from './vault-proof';
export type DocumentContext = { version: 1; kind: 'document_key'; account: string; document: string; epoch: number };
export type Device = { id: string; encryption: number[]; signing: number[] };
export type Membership = { document: DocumentContext; root_epoch: number; authority: number[]; generation: number; device: Device; role: 'read' | 'write'; signature: number[] };
export type Binding = { protocol: 1; document: DocumentContext; application: string; revision: string; schema_epoch: number; schema_digest: string; generation: number };
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
