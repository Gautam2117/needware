import {afterEach,expect,it,vi} from 'vitest';
import {trustedClientAddress} from './ingress';
afterEach(()=>vi.unstubAllEnvs());
it('ignores caller identities without an explicitly trusted ingress',()=>{
  vi.stubEnv('NEEDWARE_TRUST_PROXY','');vi.stubEnv('VERCEL','');vi.stubEnv('NEEDWARE_LOOPBACK_INGRESS','');
  expect(trustedClientAddress(new Headers({'x-needware-client-ip':'8.8.8.8','x-vercel-forwarded-for':'1.1.1.1','x-forwarded-for':'9.9.9.9','x-needware-auth-ip':'8.8.4.4'}))).toBeUndefined();
});
it('requires the managed loopback runtime and a single valid Caddy address',()=>{
  vi.stubEnv('NEEDWARE_TRUST_PROXY','caddy-loopback');vi.stubEnv('NEEDWARE_LOOPBACK_INGRESS','');
  expect(trustedClientAddress(new Headers({'x-needware-client-ip':'8.8.8.8'}))).toBeUndefined();
  vi.stubEnv('NEEDWARE_LOOPBACK_INGRESS','1');
  for(const value of ['8.8.8.8','2001:4860:4860::8888'])expect(trustedClientAddress(new Headers({'x-needware-client-ip':value}))).toBe(value);
  for(const value of ['unknown','8.8.8.8,1.1.1.1','8.8.8.8:1234'])expect(trustedClientAddress(new Headers({'x-needware-client-ip':value}))).toBeUndefined();
});
it('retains the Vercel platform guard and validates its first address',()=>{
  vi.stubEnv('NEEDWARE_TRUST_PROXY','vercel');vi.stubEnv('VERCEL','');
  expect(trustedClientAddress(new Headers({'x-vercel-forwarded-for':'8.8.8.8'}))).toBeUndefined();
  vi.stubEnv('VERCEL','1');expect(trustedClientAddress(new Headers({'x-vercel-forwarded-for':'8.8.8.8, 1.1.1.1'}))).toBe('8.8.8.8');
  expect(trustedClientAddress(new Headers({'x-vercel-forwarded-for':'malformed'}))).toBeUndefined();
});
