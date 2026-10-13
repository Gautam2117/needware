import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderConfiguration} from './render-service.mjs';
const preview={RENDER:'true',NEEDWARE_RENDER_FREE:'1',RENDER_GIT_COMMIT:'a'.repeat(40),NEEDWARE_RELEASE_SHA:'a'.repeat(40),PORT:'10000',RENDER_EXTERNAL_HOSTNAME:'needware-test.onrender.com',RENDER_EXTERNAL_URL:'https://needware-test.onrender.com',NEEDWARE_RENDER_STAGE:'preview',NEEDWARE_BILLING_MODE:'disabled',NEEDWARE_HOSTED_GENERATION:'0'};
test('public hosting probe excludes accounts and paid generation',()=>assert.deepEqual(renderConfiguration(preview),{issues:[],host:'needware-test.onrender.com',alias:'needware-test.onrender.com'}));
test('preview rejects every production secret and either activation flag',()=>{
  for(const key of ['DATABASE_URL','BETTER_AUTH_SECRET','RESEND_API_KEY','SMTP_PASSWORD','NEEDWARE_CONTROL_TOKEN','NEEDWARE_SIGNING_SEED_HEX','NEEDWARE_LOCAL_API_KEY','CASHFREE_CLIENT_SECRET','STRIPE_SECRET_KEY'])assert.ok(renderConfiguration({...preview,[key]:'private'}).issues.includes('PREVIEW_PRIVATE_'+key));
  for(const [key,value] of [['NEEDWARE_HOSTED_GENERATION','1'],['NEEDWARE_BILLING_MODE','cashfree_once']])assert.ok(renderConfiguration({...preview,[key]:value}).issues.includes('PREVIEW_PAUSED'));
});
test('runtime requires platform identity, exact release and a separate public port',()=>{
  for(const settings of [{RENDER:'false'},{NEEDWARE_RENDER_FREE:'0'},{RENDER_GIT_COMMIT:'b'.repeat(40)},{PORT:'3000'},{PORT:'3001'},{PORT:'65536'},{RENDER_EXTERNAL_URL:'http://needware-test.onrender.com'},{RENDER_EXTERNAL_URL:'https://user:password@needware-test.onrender.com'},{RENDER_EXTERNAL_HOSTNAME:'unexpected.example.com'}])assert.ok(renderConfiguration({...preview,...settings}).issues.length>0);
});
test('fixture activation, TLS bypass and unspecified stages stay closed',()=>{
  for(const settings of [{NEEDWARE_FIXTURE_MODE:'1'},{NEEDWARE_BILLING_FIXTURE:'1'},{NEEDWARE_ALLOW_LOOPBACK:'1'},{NODE_TLS_REJECT_UNAUTHORIZED:'0'},{NEEDWARE_RENDER_STAGE:'unknown'}])assert.ok(renderConfiguration({...preview,...settings}).issues.length>0);
});
test('production needs verified account configuration and HTTPS transactional delivery',()=>{
  const result=renderConfiguration({...preview,NEEDWARE_RENDER_STAGE:'production',BETTER_AUTH_URL:'https://needware.continuumarc.tech'});
  for(const code of ['DATABASE_URL','BETTER_AUTH_SECRET','HTTPS_MAIL_REQUIRED','MAIL_DISPATCH_REQUIRED','LOOPBACK_TOPOLOGY'])assert.ok(result.issues.includes(code));
  assert.ok(!result.issues.includes('NEEDWARE_HOSTED_GENERATION'));assert.equal(result.host,'needware.continuumarc.tech');
});
