import assert from 'node:assert/strict';
import {expect} from '@playwright/test';
import {execFileSync,spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {advanceAcceptanceWindow} from './acceptance-clock.mjs';
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{default:canonicalize}=await import(require.resolve('canonicalize'));
export async function verifyGeneration({page,otherPage,enrolledPage,context,pool,account,otherAccount,origin}){
  assert.equal(await advanceAcceptanceWindow(pool,{account}),true,'Generation fault injection requires a guarded disposable database');
  const window=async()=>{await advanceAcceptanceWindow(pool,{account});await advanceAcceptanceWindow(pool,{account:otherAccount});};
  const provider=(await(await page.request.get(`${origin}/api/providers`)).json()).provider;assert.equal(provider.fixture,true);assert.equal(provider.max_cost_microusd,500000);
  const recipient=await page.evaluate(()=>JSON.parse(globalThis.__needwareRelay.vault.device_certificate()));
  const otherRecipient=await otherPage.evaluate(()=>JSON.parse(globalThis.__editableRelay.vault.device_certificate()));
  const headers={Origin:origin,'Content-Type':'application/json'},post=(client,payload)=>client.request.post(`${origin}/api/generation/jobs`,{headers,data:canonicalize(payload)}),payload=(id=randomUUID(),cert=recipient)=>({id,prompt:'Track habits',recipient:cert,provider,consent:true});
  const once=()=>execFileSync(process.execPath,['scripts/generation-worker.mjs','--once'],{env:process.env,stdio:'inherit',timeout:60000});
  const record=async id=>(await pool.query('SELECT * FROM needware_generation_job WHERE id=$1',[id])).rows[0];
  const count=async()=>(await(await fetch(new URL('/fixture-count',process.env.NEEDWARE_LOCAL_ENDPOINT))).json()).requests;
  const anonymous=await context.browser().newContext();try{assert.equal((await post({request:anonymous.request},payload())).status(),401);}finally{await anonymous.close();}
  assert.equal((await page.request.post(`${origin}/api/compile-jobs`,{headers,data:{prompt:'Quota bypass'}})).status(),403);
  assert.equal((await page.request.post(`${origin}/api/generation/jobs`,{headers:{...headers,Origin:'https://attacker.invalid'},data:canonicalize(payload())})).status(),403);
  assert.equal((await post(page,{...payload(),recipient:otherRecipient})).status(),400);
  assert.equal((await post(page,{...payload(),provider:{...provider,model:'unreviewed'}})).status(),409);
  await pool.query(`CREATE FUNCTION reject_generation_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Acceptance enqueue failure';END$$; CREATE TRIGGER reject_generation_insert BEFORE INSERT ON needware_generation_job FOR EACH ROW EXECUTE FUNCTION reject_generation_insert()`);
  const fault=payload();try{assert.equal((await post(page,fault)).status(),503);assert.equal(await record(fault.id),undefined);assert.equal((await pool.query('SELECT account_id FROM needware_generation_usage WHERE account_id=$1',[account])).rowCount,0);}finally{await pool.query('DROP TRIGGER reject_generation_insert ON needware_generation_job;DROP FUNCTION reject_generation_insert()');}
  const first=payload();await window();const parallel=await Promise.all([post(page,first),post(page,first)]);for(const response of parallel)assert.equal(response.status(),202,await response.text());
  assert.equal((await post(page,{...first,prompt:'Different request'})).status(),409);
  assert.equal((await otherPage.request.get(`${origin}/api/generation/jobs/${first.id}`)).status(),404);
  assert.equal((await page.request.get(`${origin}/api/generation/jobs/${first.id}?result=1`)).status(),409);
  const second=payload();assert.equal((await post(page,second)).status(),202);assert.equal((await post(page,payload())).status(),429);
  let ledger=(await pool.query('SELECT * FROM needware_generation_usage WHERE account_id=$1',[account])).rows[0];assert.equal(ledger.attempts,2);assert.equal(Number(ledger.reserved_microusd),1000000);
  await window();assert.equal((await page.request.post(`${origin}/api/generation/jobs/${second.id}`,{headers,data:canonicalize({action:'cancel'})})).status(),202);assert.equal((await record(second.id)).state,'cancelled');assert.equal((await record(second.id)).prompt,null);
  // Restart before dispatch: an expired lease is safe to reclaim. No paid request was sent.
  await pool.query(`UPDATE needware_generation_job SET state='running',attempts=1,lease_id=$2,lease_until=now()-interval '1 second' WHERE id=$1`,[first.id,randomUUID()]);
  const before=await count();once();const finished=await record(first.id);assert.equal(finished.state,'succeeded',finished.failure);assert.equal(finished.attempts,2);assert.equal(finished.prompt,null);assert.equal(finished.lease_id,null);assert(finished.result_ciphertext.length>16);assert(!finished.result_ciphertext.includes(Buffer.from('Track habits')));assert.equal(await count(),before+2);
  ledger=(await pool.query('SELECT * FROM needware_generation_usage WHERE account_id=$1',[account])).rows[0];assert.equal(Number(ledger.reserved_microusd),0);assert.equal(Number(ledger.spent_microusd),400);assert.equal(Number(ledger.input_tokens),200);assert.equal(Number(ledger.output_tokens),200);
  await window();const result=await(await page.request.get(`${origin}/api/generation/jobs/${first.id}?result=1`)).json();assert.equal(result.job,first.id);
  assert.equal(await page.evaluate(value=>{const r=globalThis.__needwareRelay,bytes=r.vault.open_generation_package(value.job,JSON.stringify(value.metadata),Uint8Array.from(atob(value.ciphertext),c=>c.charCodeAt(0))),info=JSON.parse(r.wasm.inspect_package(bytes));bytes.fill(0);return info.digest;},result),finished.package_digest);
  await enrolledPage.evaluate(async()=>{const wasm=await import('/wasm/needware_wasm.js');await wasm.default({module_or_path:'/wasm/needware_wasm_bg.wasm'});const {openVaultStore}=await import('/vault-store.js'),account=(await(await fetch('/api/auth/get-session')).json()).user.id,store=await openVaultStore(),root=await store.load(account);globalThis.__generationPeer=wasm.BrowserVault.from_local_backup(root.bytes);root.bytes.fill(0);});
  assert.equal(await enrolledPage.evaluate(value=>{try{globalThis.__generationPeer.open_generation_package(value.job,JSON.stringify(value.metadata),Uint8Array.from(atob(value.ciphertext),c=>c.charCodeAt(0)));return false;}catch{return true;}},result),true);
  await page.goto(`${origin}/generation`);await expect(page.getByRole('heading',{name:'Your creations',exact:true})).toBeVisible();await expect(page.getByText(first.id,{exact:true})).toBeVisible();await page.reload();await expect(page.getByText(first.id,{exact:true})).toBeVisible();
  await window();await page.getByRole('link',{name:'Review encrypted result',exact:true}).click();await expect(page.getByText('Creation finished. Review its signer and permissions before saving it encrypted.',{exact:true})).toBeVisible();
  const previousDocuments=await page.locator('[data-document]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-document')));
  await page.getByRole('button',{name:'Trust signer and save encrypted application',exact:true}).click();const app=page.frameLocator('iframe');await app.getByLabel('Habit name').fill('Hosted generation survived restart');await app.getByRole('button',{name:'Add habit',exact:true}).click();await expect(app.getByText('Hosted generation survived restart',{exact:true})).toBeVisible();
  // A fresh page can open encrypted durable application data after import.
  const createdDocument=await page.locator('[data-document]').evaluateAll((nodes,previous)=>nodes.map(node=>node.getAttribute('data-document')).find(id=>!previous.includes(id)),previousDocuments);assert(createdDocument);
  await page.goto(`${origin}/encrypted#account=${account}`);await page.locator(`[data-document="${createdDocument}"]`).getByRole('button',{name:'Open Habit tracker',exact:true}).click();await expect(app.getByText('Hosted generation survived restart',{exact:true})).toBeVisible();
  const third=payload();await window();assert.equal((await post(page,third)).status(),202);assert.equal((await post(page,payload())).status(),429,'Free daily quota remains enforced after cancellation');
  await pool.query(`UPDATE needware_generation_job SET state='running',attempts=1,lease_id=$2,lease_until=now()-interval '1 second',dispatched_at=now() WHERE id=$1`,[third.id,randomUUID()]);const interruptedCount=await count();once();assert.equal(await count(),interruptedCount);const interrupted=await record(third.id);assert.equal(interrupted.state,'failed');assert.equal(interrupted.failure,'INTERRUPTED_USAGE_UNKNOWN');assert.equal(interrupted.result_ciphertext,null);assert.equal(interrupted.prompt,null);
  ledger=(await pool.query('SELECT * FROM needware_generation_usage WHERE account_id=$1',[account])).rows[0];assert.equal(Number(ledger.spent_microusd),500400);assert.equal(ledger.unknown_requests,1);assert.equal(Number(ledger.reserved_microusd),0);
  // Paid entitlement fixture is limited to this guarded disposable account, never production.
  await pool.query(`INSERT INTO needware_entitlement(account_id,plan,paid_until) VALUES($1,'pro',now()+interval '1 day')`,[account]);
  await window();await page.goto(origin);await page.getByLabel('Describe your application',{exact:true}).fill('Track habits from the hosted consumer UI');await page.getByRole('checkbox').check();
  const submission=page.waitForResponse(response=>response.url()===`${origin}/api/generation/jobs`&&response.request().method()==='POST');await page.getByRole('button',{name:'Create application',exact:true}).click();const uiResponse=await submission;assert.equal(uiResponse.status(),202,await uiResponse.text());const uiJob=(await uiResponse.json()).job;
  await page.goto(`${origin}/generation`);await expect(page.getByText(uiJob.id,{exact:true})).toBeVisible();await page.reload();await expect(page.getByText(uiJob.id,{exact:true})).toBeVisible();assert.equal((await record(uiJob.id)).state,'queued');
  await page.getByRole('button',{name:'Cancel creation',exact:true}).click();await expect(page.getByRole('button',{name:'Cancel creation',exact:true})).toHaveCount(0);assert.equal((await record(uiJob.id)).state,'cancelled');
  await window();const revoked=payload();assert.equal((await post(page,revoked)).status(),202);const device=(await pool.query('DELETE FROM needware_vault_device WHERE account_id=$1 AND device_id=$2 RETURNING *',[account,recipient.device.id])).rows[0];
  const revokedCount=await count();once();assert.equal(await count(),revokedCount);assert.equal((await record(revoked.id)).failure,'DEVICE_CHANGED');await window();assert.equal((await page.request.get(`${origin}/api/generation/jobs/${first.id}?result=1`)).status(),403);
  await pool.query('INSERT INTO needware_vault_device(account_id,device_id,certificate,label,created_at) VALUES($1,$2,$3,$4,$5)',[account,device.device_id,canonicalize(device.certificate),device.label,device.created_at]);
  await window();const cancelled=payload();assert.equal((await post(page,cancelled)).status(),202);
  const worker=spawn(process.execPath,['scripts/generation-worker.mjs','--once'],{env:process.env,stdio:'inherit'}),closed=new Promise(resolve=>worker.once('close',resolve));
  try{let dispatched=false;for(let i=0;i<100;i++){if((await record(cancelled.id)).dispatched_at){dispatched=true;break;}await new Promise(resolve=>setTimeout(resolve,30));}assert(dispatched);assert.equal((await page.request.post(`${origin}/api/generation/jobs/${cancelled.id}`,{headers,data:canonicalize({action:'cancel'})})).status(),202);assert.equal(await closed,0);}finally{if(worker.exitCode===null)worker.kill('SIGTERM');}
  const stopped=await record(cancelled.id);assert.equal(stopped.state,'cancelled');assert.equal(stopped.result_ciphertext,null);assert.equal(stopped.prompt,null);
  await window();const ownUsage=(await(await page.request.get(`${origin}/api/generation/jobs`)).json()).usage;assert.equal(ownUsage.plan,'pro');assert.equal(ownUsage.attempts,6);assert.equal(Number(ownUsage.reserved_microusd),0);
  const expired=payload();assert.equal((await post(page,expired)).status(),202);await pool.query(`UPDATE needware_generation_job SET created_at=now()-interval '25 hours' WHERE id=$1`,[expired.id]);const expiryCount=await count();once();assert.equal(await count(),expiryCount);assert.equal((await record(expired.id)).failure,'REQUEST_EXPIRED');assert.equal((await record(expired.id)).prompt,null);
  // Storage fixture rows exercise the byte cap while daily/count/cost limits still allow creation.
  const filled=await pool.query(`INSERT INTO needware_generation_job(id,owner_id,request_digest,recipient,provider,period,reservation,state,result_metadata,result_ciphertext,package_digest,finished_at)
    SELECT gen_random_uuid(),owner_id,request_digest,recipient,provider,period,0,'succeeded',result_metadata,decode(repeat('00',4194304),'hex'),package_digest,now() FROM needware_generation_job CROSS JOIN generate_series(1,32) WHERE id=$1 RETURNING id`,[first.id]);
  try{await window();const full=await post(page,payload());assert.equal(full.status(),429);assert.match((await full.json()).message,/storage is full/);}finally{await pool.query('DELETE FROM needware_generation_job WHERE id=ANY($1::uuid[])',[filled.rows.map(row=>row.id)]);}
  await pool.query(`UPDATE needware_generation_job SET finished_at=now()-interval '31 days' WHERE id=$1`,[first.id]);await window();assert.equal((await page.request.get(`${origin}/api/generation/jobs/${first.id}?result=1`)).status(),410);const spentBeforePrune=(await pool.query('SELECT spent_microusd FROM needware_generation_usage WHERE account_id=$1',[account])).rows[0].spent_microusd;once();assert.equal(await record(first.id),undefined);assert.equal((await pool.query('SELECT spent_microusd FROM needware_generation_usage WHERE account_id=$1',[account])).rows[0].spent_microusd,spentBeforePrune);
  await page.goto(`${origin}/encrypted#account=${account}`);await page.locator(`[data-document="${createdDocument}"]`).getByRole('button',{name:'Open Habit tracker',exact:true}).click();await expect(app.getByText('Hosted generation survived restart',{exact:true})).toBeVisible();
  await pool.query(`UPDATE needware_entitlement SET paid_until=now()-interval '1 second' WHERE account_id=$1`,[account]);assert.equal((await post(page,payload())).status(),429,'Expired entitlement must restore free quota');
  await pool.query(`UPDATE needware_entitlement SET paid_until=now()+interval '1 day' WHERE account_id=$1`,[account]);await pool.query('UPDATE needware_generation_usage SET spent_microusd=100000000 WHERE account_id=$1',[account]);assert.equal((await post(page,payload())).status(),429,'Cost budget cannot be bypassed');
  // Retained Pro rows cannot raise the quota when this installation disables billing.
  const {generationUsage,createGenerationJob}=await import('../apps/web/lib/generation-store.ts'),priorMode=process.env.NEEDWARE_BILLING_MODE;
  await pool.query('UPDATE needware_generation_usage SET spent_microusd=0 WHERE account_id=$1',[account]);
  const beforeDisabled=(await pool.query('SELECT count(*)::int AS count FROM needware_generation_job WHERE owner_id=$1',[account])).rows[0].count;
  try{process.env.NEEDWARE_BILLING_MODE='disabled';assert.equal((await generationUsage(pool,account)).plan,'free');
    await assert.rejects(createGenerationJob(pool,account,randomUUID(),'Track habits',recipient,provider,500000),error=>error.status===429);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM needware_generation_job WHERE owner_id=$1',[account])).rows[0].count,beforeDisabled);
  }finally{if(priorMode===undefined)delete process.env.NEEDWARE_BILLING_MODE;else process.env.NEEDWARE_BILLING_MODE=priorMode;}
  assert.equal((await generationUsage(pool,account)).plan,'pro');
  // Deletion cascades queued requests and cost reservations with the account.
  await window();const deleted=payload(randomUUID(),otherRecipient);assert.equal((await post(otherPage,deleted)).status(),202);await pool.query('DELETE FROM auth_user WHERE id=$1',[otherAccount]);once();assert.equal(await record(deleted.id),undefined);assert.equal((await pool.query('SELECT account_id FROM needware_generation_usage WHERE account_id=$1',[otherAccount])).rowCount,0);
  await window();await page.goto(`${origin}/account`);await expect(page.getByRole('button',{name:'Sign out everywhere',exact:true})).toBeVisible();
  console.log('PASS hosted generation: durable leases/idempotency, quotas/costs, cancellation, revoked-device denial, encrypted result/review/import, cold reopen and deletion; authored provider fixture only');
}
