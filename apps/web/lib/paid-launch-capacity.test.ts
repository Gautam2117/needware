import {describe,it,expect} from 'vitest';
import {creationReady,paidLaunchLimit} from './paid-launch-capacity';
describe('paid launch admission',()=>{
 it('closes purchases for exhausted, paused, busy or unknown capacity',()=>{
  for(const state of ['paused','daily_limit','busy','unknown'])expect(creationReady({state})).toBe(false);
  expect(creationReady({state:'ready'})).toBe(true);
  expect(creationReady()).toBe(true); // Existing local installations without shared policy.
 });
 it('bounds the cohort and fails closed for malformed configuration',()=>{
  expect(paidLaunchLimit({})).toBe(3);
  for(const value of ['0','-1','11','02','1.5','NaN',''])expect(()=>paidLaunchLimit({NEEDWARE_PAID_COHORT_LIMIT:value})).toThrow();
  expect(paidLaunchLimit({NEEDWARE_PAID_COHORT_LIMIT:'10'})).toBe(10);
 });
});
