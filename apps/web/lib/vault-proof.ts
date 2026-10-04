import { createHash, createPublicKey, verify } from 'node:crypto';
import canonicalize from 'canonicalize';
import { CloudError } from './cloud-request';

export type Context = { version: 1; kind: 'account_root'; account: string; document: null; epoch: number };
export type Certificate = { context: Context; device: { id: string; encryption: number[]; signing: number[] }; authority: number[]; signature: number[] };
export type RecoveryEnvelope = { context: Context; authority: number[]; ciphertext: number[] };
export type VaultOperation = 'create_vault' | 'register_device' | 'relay_document';
export type OperationProof = { certificate: Certificate; nonce: string; operation: VaultOperation; digest: number[]; signature: number[] };
export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new CloudError(400, 'Invalid vault structure');
  return value as Record<string, unknown>;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new CloudError(400, 'Invalid vault identity');
  return value;
}
export function bytes(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)) throw new CloudError(400, 'Invalid vault bytes');
  return value;
}
export function publicKey(value: unknown): number[] {
  const key = bytes(value, 32); if (key.every(item => item === 0)) throw new CloudError(400, 'Invalid public key'); return key;
}
export function context(value: unknown, account: string): Context {
  const fields = object(value, ['version', 'kind', 'account', 'document', 'epoch']);
  if (fields.version !== 1 || fields.kind !== 'account_root' || fields.account !== account || fields.document !== null
      || !Number.isInteger(fields.epoch) || Number(fields.epoch) < 1 || Number(fields.epoch) > 4294967295) throw new CloudError(400, 'Invalid account key context');
  return fields as Context;
}
export function checkSignature(key: number[], domain: string, value: unknown, signature: number[]): void {
  try {
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]);
    if (!verify(null, Buffer.concat([Buffer.from(domain + '\0'), Buffer.from(canonicalize(value)!)]),
      createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(signature))) throw new Error();
  } catch { throw new CloudError(403, 'Encryption-device signature did not verify'); }
}
export function certificate(value: unknown, account: string): Certificate {
  const fields = object(value, ['context', 'device', 'authority', 'signature']);
  const ctx = context(fields.context, account); const device = object(fields.device, ['id', 'encryption', 'signing']);
  uuid(device.id); publicKey(device.encryption); publicKey(device.signing);
  const authority = publicKey(fields.authority); const signature = bytes(fields.signature, 64);
  checkSignature(authority, 'NEEDWARE-DEVICE-CERTIFICATE', [ctx, device, authority], signature);
  return fields as Certificate;
}
export function recovery(value: unknown, cert: Certificate): RecoveryEnvelope {
  const fields = object(value, ['context', 'authority', 'ciphertext']);
  context(fields.context, cert.context.account); publicKey(fields.authority); bytes(fields.ciphertext, 72);
  if (canonicalize(fields.context) !== canonicalize(cert.context) || canonicalize(fields.authority) !== canonicalize(cert.authority)) throw new CloudError(400, 'Recovery identity mismatch');
  return fields as RecoveryEnvelope;
}
export function operationProof(value: unknown, account: string, payload: unknown): OperationProof {
  const fields = object(value, ['certificate', 'nonce', 'operation', 'digest', 'signature']);
  const cert = certificate(fields.certificate, account); uuid(fields.nonce);
  if (!['create_vault', 'register_device', 'relay_document'].includes(String(fields.operation))) throw new CloudError(400, 'Invalid vault operation');
  const digest = bytes(fields.digest, 32); const signature = bytes(fields.signature, 64);
  const expected = createHash('sha256').update(canonicalize(payload)!).digest();
  if (!expected.equals(Buffer.from(digest))) throw new CloudError(403, 'Vault payload proof mismatch');
  checkSignature(cert.device.signing, 'NEEDWARE-ACCOUNT-OPERATION', [cert.context, cert.device, fields.nonce, fields.operation, digest], signature);
  return fields as OperationProof;
}
