import canonicalize from 'canonicalize';
import { CloudError } from './cloud-request';
import { bytes, checkSignature, context, object, publicKey, type Context } from './vault-proof';

export type RootTransition = { previous: Context; next: Context; previous_authority: number[]; next_authority: number[]; signature: number[] };
export type RootRotation = { transition: RootTransition; acceptance: number[] };

/** The caller must obtain the previous pin from the locked account row. */
export function rootRotation(value: unknown, previous: Context, pin: Uint8Array): RootRotation {
  const rotation = object(value, ['transition', 'acceptance']);
  const fields = object(rotation.transition, ['previous', 'next', 'previous_authority', 'next_authority', 'signature']);
  const old = context(fields.previous, previous.account), next = context(fields.next, previous.account);
  const oldAuthority = publicKey(fields.previous_authority), nextAuthority = publicKey(fields.next_authority);
  if (canonicalize(old) !== canonicalize(previous) || next.epoch !== old.epoch + 1
      || !Buffer.from(oldAuthority).equals(pin) || Buffer.from(oldAuthority).equals(Buffer.from(nextAuthority))) {
    throw new CloudError(403, 'Account root transition does not match current authority');
  }
  const signature = bytes(fields.signature, 64), acceptance = bytes(rotation.acceptance, 64);
  checkSignature(oldAuthority, 'NEEDWARE-ROOT-TRANSITION', [old, next, oldAuthority, nextAuthority], signature);
  const transition = { previous: old, next, previous_authority: oldAuthority, next_authority: nextAuthority, signature };
  checkSignature(nextAuthority, 'NEEDWARE-ROOT-ROTATION-ACCEPT-v1', transition, acceptance);
  return { transition, acceptance };
}
