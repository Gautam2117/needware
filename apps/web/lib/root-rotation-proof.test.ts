import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { rootRotation } from './root-rotation-proof';
vi.mock('./cloud-request', () => ({ CloudError: class extends Error { constructor(readonly status: number, message: string) { super(message); } } }));
const fixture = JSON.parse(readFileSync(new URL('../../../artifacts/epoch-proof-fixture.json', import.meta.url), 'utf8'));
describe('native root-rotation authorization', () => {
  it('verifies both native signatures against the independent current pin', () => {
    expect(rootRotation(fixture.root_rotation, fixture.root, Buffer.from(fixture.authority))).toEqual(fixture.root_rotation);
  });
  it('rejects every tampered old-root and new-root signature byte', () => {
    for (let index = 0; index < 64; index++) for (const field of ['signature', 'acceptance']) {
      const altered = structuredClone(fixture.root_rotation);
      if (field === 'signature') altered.transition.signature[index] ^= 1; else altered.acceptance[index] ^= 1;
      expect(() => rootRotation(altered, fixture.root, Buffer.from(fixture.authority))).toThrow();
    }
  });
  it('rejects stale pins, replay, account substitution, unknown fields and malformed keys', () => {
    const proof = fixture.root_rotation;
    expect(() => rootRotation(proof, proof.transition.next, Buffer.from(proof.transition.next_authority))).toThrow();
    expect(() => rootRotation(proof, { ...fixture.root, account: '00000000-0000-4000-8000-000000000000' }, Buffer.from(fixture.authority))).toThrow();
    expect(() => rootRotation({ ...proof, extra: true }, fixture.root, Buffer.from(fixture.authority))).toThrow();
    for (const field of ['previous_authority', 'next_authority']) {
      const altered = structuredClone(proof); altered.transition[field] = Array(32).fill(0);
      expect(() => rootRotation(altered, fixture.root, Buffer.from(fixture.authority))).toThrow();
    }
  });
});
