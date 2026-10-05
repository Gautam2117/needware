import {describe,it,expect} from 'vitest';
import {operatorAllowed} from './operations-authority';
describe('configured operator authority',()=>{it('fails closed for absent, malformed, duplicated, oversized and partial-match allowlists',()=>{
  const account='12345678-1234-1234-1234-123456789abc',other='12345678-1234-1234-1234-123456789abd';
  expect(operatorAllowed(account,account)).toBe(true);expect(operatorAllowed(account,`${other},${account}`)).toBe(true);
  for(const value of ['',other,`${account},`,`,${account}`,` ${account}`,`${account},${account}`,`${account},invalid`,account.toUpperCase(),Array.from({length:17},(_,index)=>`12345678-1234-1234-1234-${String(index).padStart(12,'0')}`).join(',')])expect(operatorAllowed(account,value)).toBe(false);
  expect(operatorAllowed(account.slice(0,-1),account)).toBe(false);
});});
