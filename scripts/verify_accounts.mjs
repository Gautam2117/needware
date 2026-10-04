import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { loadEnvironment } from './load-environment.mjs';
import { verifyAccountVault } from './verify_account_vault.mjs';
loadEnvironment(); mkdirSync('.logs', { recursive: true });
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
process.env.BETTER_AUTH_URL = origin;
const environment = { ...process.env };
execFileSync('node', ['scripts/auth-migrate.mjs'], { env: environment, stdio: 'inherit' });
const { authResources } = await import('../apps/web/lib/auth-options.ts');
const { pool } = authResources();
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createRateLimitKey } = await import(require.resolve('@better-auth/core/utils/ip'));
const rateKeys = ['/sign-in/email', '/sign-up/email', '/request-password-reset', '/send-verification-email']
  .map(path => createRateLimitKey('127.0.0.1', path));
// Preserve real shared counters across reruns; allow their normal window to expire.
const prior = await pool.query('SELECT max("lastRequest") AS latest FROM auth_rate_limit WHERE key = ANY($1)', [rateKeys]);
const wait = Math.max(0, Number(prior.rows[0].latest ?? 0) + 61_000 - Date.now());
if (wait) {
  console.log('Account acceptance waiting for the existing local rate-limit window');
  await new Promise(resolve => setTimeout(resolve, Math.min(wait, 61_000)));
}
const email = `needware-${crypto.randomUUID()}@example.invalid`;
const password = crypto.randomUUID() + crypto.randomUUID();
const nextPassword = crypto.randomUUID() + crypto.randomUUID();
const children = [];
function start(name, command, args, env = environment) {
  const log = createWriteStream(`.logs/accounts-${name}.log`, { flags: 'a' });
  const child = spawn(command, args, { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log); child.closed = new Promise(resolve => child.once('close', resolve)); children.push(child); return child;
}
async function stop(child) {
  const signal = value => {
    try { if (process.platform !== 'win32') process.kill(-child.pid, value); else child.kill(value); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  if (child.exitCode === null && child.signalCode === null) {
    signal('SIGTERM');
    await Promise.race([child.closed, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) { signal('SIGKILL'); await child.closed; }
  }
}
async function ready() {
  for (let attempt = 0; attempt < 300; attempt++) {
    try { if ((await fetch(`${origin}/account`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Await actual service readiness. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Account server did not start; see private .logs/accounts-web.log');
}
async function mailLink(subject) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`http://127.0.0.1:58025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const list = await response.json(); const message = list.messages.find(value => value.Subject === subject);
    if (message) {
      const detail = await (await fetch(`http://127.0.0.1:58025/api/v1/message/${message.ID}`)).json();
      const link = detail.Text.match(/https?:\/\/[^\s]+/)?.[0];
      if (link) { assert.equal(new URL(link).origin, origin); return link; }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const queue = await pool.query('SELECT attempts,last_error,(lease_until > now()) AS leased FROM needware_email_outbox WHERE recipient=$1', [email]);
  console.error('Fixture email queue diagnostic', queue.rows);
  try { console.error('Mail worker diagnostic', readFileSync('.logs/accounts-mail.log', 'utf8').split('\n').slice(-8).join('\n')); } catch { /* No worker log was created. */ }
  throw new Error('Fixture verification email was not captured');
}
let browser;
try {
  let web = start('web', 'pnpm', ['--filter', '@needware/web', 'start', '--port', String(port)]); await ready();
  browser = await chromium.launch(); const context = await browser.newContext(); const page = await context.newPage();
  const refusedEmail = `failed-${crypto.randomUUID()}@example.invalid`;
  const constraint = `outbox_fixture_${crypto.randomUUID().replaceAll('-', '')}`;
  // Refuse only this fixture's outbox insert; PostgreSQL must roll back its signup.
  await pool.query(`ALTER TABLE needware_email_outbox ADD CONSTRAINT ${constraint} CHECK (recipient <> '${refusedEmail}') NOT VALID`);
  try {
    const refused = await context.request.post(`${origin}/api/auth/sign-up/email`, {
      data: { name: 'Atomic signup fixture', email: refusedEmail, password }, headers: { Origin: origin },
    });
    assert.equal(refused.status(), 503);
    assert.equal((await pool.query('SELECT id FROM auth_user WHERE email=$1', [refusedEmail])).rowCount, 0);
  } finally { await pool.query(`ALTER TABLE needware_email_outbox DROP CONSTRAINT ${constraint}`); }
  await page.goto(`${origin}/account`);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Your name').fill('Needware acceptance fixture');
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account and send verification', exact: true }).click();
  await page.getByText('Check your email to verify your account, then sign in.', { exact: true }).waitFor();
  const users = await pool.query('SELECT id, "emailVerified" FROM auth_user WHERE email=$1', [email]);
  assert.equal(users.rowCount, 1); const userId = users.rows[0].id; assert.equal(users.rows[0].emailVerified, false);
  const accounts = await pool.query('SELECT password FROM auth_account WHERE "userId"=$1', [userId]);
  assert(accounts.rows[0].password.length > 64 && !accounts.rows[0].password.includes(password));
  const post = (path, body, headers = {}) => context.request.post(`${origin}/api/auth/${path}`, { data: body, headers: { Origin: origin, ...headers } });
  let response = await post('sign-in/email', { email, password }); assert.equal(response.status(), 403);
  response = await post('sign-in/email', { email, password }, { Origin: 'https://attacker.example.invalid' }); assert.equal(response.status(), 403);
  response = await post('sign-in/email', { email, password }, { Origin: '' }); assert.equal(response.status(), 403);
  response = await context.request.post(`${origin}/api/auth/sign-in/email`, { data: { padding: 'x'.repeat(70 * 1024) }, headers: { Origin: origin } }); assert.equal(response.status(), 413);
  // An unavailable SMTP service keeps the committed outbox and schedules an actual retry.
  execFileSync('node', ['scripts/mail-worker.mjs', '--once'], { env: { ...environment, SMTP_PORT: '9' }, stdio: 'inherit' });
  const retry = await pool.query('SELECT attempts, last_error FROM needware_email_outbox WHERE user_id=$1', [userId]);
  assert.equal(retry.rowCount, 1); assert.equal(retry.rows[0].attempts, 1); assert.equal(retry.rows[0].last_error, 'DELIVERY_FAILED');
  await page.goto(`${origin}/account?error=token_expired`);
  await page.getByRole('alert').getByText('This account link is invalid or expired. Request a new link below.').waitFor();
  await page.getByRole('button', { name: 'Resend verification', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByRole('button', { name: 'Send verification link', exact: true }).click();
  await page.getByText('If this account needs verification, a new link will arrive shortly.', { exact: true }).waitFor();
  assert.equal((await pool.query('SELECT id FROM needware_email_outbox WHERE user_id=$1', [userId])).rowCount, 2);
  // Restart the actual account HTTP process before delivering the durable verification job.
  await stop(web); web = start('web', 'pnpm', ['--filter', '@needware/web', 'start', '--port', String(port)]); await ready();
  start('mail', 'node', ['scripts/mail-worker.mjs']);
  const verification = await mailLink('Verify your Needware email'); await page.goto(verification);
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in to account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out everywhere', exact: true }).waitFor();
  await verifyAccountVault({ page, context, pool, account: userId, origin, email, password });
  await page.screenshot({ path: 'artifacts/account-acceptance.png', fullPage: true });
  const cookies = await context.cookies(); const sessionCookie = cookies.find(value => value.name.endsWith('session_token'));
  assert(sessionCookie?.httpOnly); assert.equal(sessionCookie.sameSite, 'Lax'); assert.equal(sessionCookie.secure, false);
  const other = await browser.newContext();
  response = await other.request.post(`${origin}/api/auth/sign-in/email`, { data: { email, password }, headers: { Origin: origin } }); assert.equal(response.status(), 200);
  const otherSession = await (await other.request.get(`${origin}/api/auth/get-session`)).json(); assert.equal(otherSession.user.id, userId);
  await page.reload();
  const otherCard = page.locator('article').filter({ has: page.getByText('Another browser', { exact: true }) });
  await otherCard.getByRole('button', { name: 'Revoke session', exact: true }).click();
  await otherCard.waitFor({ state: 'hidden' });
  assert.equal(await (await other.request.get(`${origin}/api/auth/get-session`)).json(), null);
  assert.equal((await other.request.get(`${origin}/api/vault`)).status(), 401);
  response = await other.request.post(`${origin}/api/auth/sign-in/email`, { data: { email, password }, headers: { Origin: origin } }); assert.equal(response.status(), 200);
  await page.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in to account', exact: true }).waitFor();
  assert.equal(await (await other.request.get(`${origin}/api/auth/get-session`)).json(), null);
  response = await other.request.post(`${origin}/api/auth/sign-in/email`, { data: { email, password }, headers: { Origin: origin } }); assert.equal(response.status(), 200);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByRole('button', { name: 'Send password reset link' }).click();
  await page.getByText('If this email has an account, a password reset link will arrive shortly.', { exact: true }).waitFor();
  const reset = await mailLink('Reset your Needware password'); await page.goto(reset);
  await page.getByLabel('New password', { exact: true }).fill(nextPassword); await page.getByLabel('Confirm password', { exact: true }).fill(nextPassword);
  await page.getByRole('button', { name: 'Update password', exact: true }).click();
  await page.getByText('Password updated and previous sessions revoked.', { exact: false }).waitFor();
  assert.equal(await (await other.request.get(`${origin}/api/auth/get-session`)).json(), null);
  response = await post('reset-password', { token: new URL(page.url()).searchParams.get('token'), newPassword: password }); assert.notEqual(response.status(), 200);
  response = await post('sign-in/email', { email, password }); assert.equal(response.status(), 401);
  await page.goto(`${origin}/account`); await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(nextPassword); await page.getByRole('button', { name: 'Sign in to account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out everywhere', exact: true }).waitFor();
  // Deletion requires a separate one-use email proof and cascades the auth/outbox rows.
  await page.getByText('Delete account', { exact: true }).click();
  await page.getByLabel('I want to delete my account').check(); await page.getByRole('button', { name: 'Send deletion confirmation' }).click();
  await page.getByText('Check your email to confirm account deletion.', { exact: true }).waitFor();
  await page.goto(await mailLink('Confirm Needware account deletion'));
  assert.equal((await pool.query('SELECT id FROM auth_user WHERE id=$1', [userId])).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM auth_session WHERE "userId"=$1', [userId])).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM auth_account WHERE "userId"=$1', [userId])).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM needware_email_outbox WHERE user_id=$1', [userId])).rowCount, 0);
  for (const table of ['needware_account_vault', 'needware_vault_device', 'needware_vault_challenge', 'needware_account_limit']) {
    assert.equal((await pool.query(`SELECT account_id FROM ${table} WHERE account_id=$1`, [userId])).rowCount, 0);
  }
  // Rate-limit identities cannot be spoofed by forwarding a caller-controlled internal header.
  let limited = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    response = await post('sign-in/email', { email, password }, { 'x-needware-auth-ip': crypto.randomUUID(), 'x-forwarded-for': crypto.randomUUID() });
    if (response.status() === 429) { limited = true; break; }
  }
  assert(limited);
  await other.close(); await context.close();
  console.log('PASS real PostgreSQL atomic signup/verification/login/session revoke/reset/replay/logout/deletion, durable SMTP retry/restart, cookies/CSRF/body/rate boundaries and Chromium UI');
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) await stop(child);
  // This cleanup is confined to the randomly named fixture created by this run.
  await pool.query('DELETE FROM auth_user WHERE email=$1', [email]); await pool.end();
}
