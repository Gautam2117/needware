'use client';
import { createAuthClient } from 'better-auth/react';
import { useEffect, useState, type FormEvent } from 'react';
import VaultPanel from './vault-panel';
export const authClient = createAuthClient();
type Session = { id: string; token: string; userAgent?: string | null; createdAt: Date };
type Mode = 'sign-in' | 'sign-up' | 'reset' | 'verify';
function checked(result: { error?: { message?: string } | null }) {
  if (result.error) throw new Error(result.error.message || 'Account request failed. Please try again.');
}
function sessionDescription(agent?: string | null): string {
  if (!agent) return 'Browser details unavailable';
  const browser = /Firefox\//.test(agent) ? 'Firefox' : /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Other client';
  const system = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Windows/.test(agent) ? 'Windows' : /Macintosh/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : 'another device';
  return `${browser} on ${system}`;
}
export default function AccountPanel({ providers, initialError = '' }: { providers: readonly ('google' | 'github')[]; initialError?: string }) {
  const { data, isPending, refetch } = authClient.useSession();
  const [mode, setMode] = useState<Mode>('sign-in'); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState(initialError);
  const [sessions, setSessions] = useState<Session[]>([]); const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  useEffect(() => {
    if (!data) return;
    let active = true;
    authClient.listSessions().then(result => { if (active && result.data) setSessions(result.data); });
    return () => { active = false; };
  }, [data]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Account service unavailable. Try again.'); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? ''); const password = String(form.get('password') ?? '');
    void run(async () => {
      if (mode === 'sign-up') {
        checked(await authClient.signUp.email({ name: String(form.get('name') ?? ''), email, password, callbackURL: '/account' }));
        setMessage('Check your email to verify your account, then sign in.');
      } else if (mode === 'reset') {
        checked(await authClient.requestPasswordReset({ email, redirectTo: `${location.origin}/account/reset` }));
        setMessage('If this email has an account, a password reset link will arrive shortly.');
      } else if (mode === 'verify') {
        checked(await authClient.sendVerificationEmail({ email, callbackURL: '/account' }));
        setMessage('If this account needs verification, a new link will arrive shortly.');
      } else {
        checked(await authClient.signIn.email({ email, password })); await refetch();
      }
    });
  }
  if (isPending) return <p role="status">Checking your session…</p>;
  return <section aria-label="Account access" className="review">
    {data ? <>
      <h2>{data.user.name}</h2><p>{data.user.email}</p>
      <div className="toolbar"><button disabled={busy} onClick={() => run(async () => { checked(await authClient.signOut()); await refetch(); })}>Sign out</button>
        <button disabled={busy} onClick={() => run(async () => { checked(await authClient.revokeSessions()); checked(await authClient.signOut()); await refetch(); })}>Sign out everywhere</button></div>
      <h2>Your sessions</h2><p>Revoking a login session prevents account access. Encryption-device revocation also requires rotating future document keys.</p>
      {sessions.map(session => <article className="app-card" key={session.id} data-session={session.id}><strong>{session.id === data.session.id ? 'This browser' : 'Another browser'}</strong>
        <p>{sessionDescription(session.userAgent)} · {new Date(session.createdAt).toLocaleString()}</p>
        <button disabled={busy} onClick={() => run(async () => { checked(await authClient.revokeSession({ token: session.token })); setSessions(current => current.filter(value => value.id !== session.id)); await refetch(); })}>Revoke session</button></article>)}
      <details><summary>Delete account</summary><p>Deletion removes your account, sessions, hosted encryption-device list and encrypted recovery backup. Local applications and your saved recovery file remain. Export anything you want to keep.</p>
        <label><input type="checkbox" checked={deleteConfirmed} onChange={event => setDeleteConfirmed(event.target.checked)} /> I want to delete my account</label>
        <button disabled={busy || !deleteConfirmed} onClick={() => run(async () => { checked(await authClient.deleteUser({ callbackURL: '/account' })); setMessage('Check your email to confirm account deletion.'); })}>Send deletion confirmation</button>
      </details>
      <VaultPanel key={data.user.id} account={data.user.id} />
    </> : <>
      <div className="toolbar" aria-label="Account actions">
        {(['sign-in', 'sign-up', 'reset', 'verify'] as const).map(value => <button key={value} aria-pressed={mode === value} disabled={busy} onClick={() => { setMode(value); setError(''); setMessage(''); }}>{value === 'sign-in' ? 'Sign in' : value === 'sign-up' ? 'Create account' : value === 'reset' ? 'Reset password' : 'Resend verification'}</button>)}
      </div>
      <form onSubmit={submit} className="account-form">
        {mode === 'sign-up' && <label>Your name<input name="name" autoComplete="name" required maxLength={128} /></label>}
        <label>Email<input name="email" type="email" autoComplete="email" required maxLength={320} /></label>
        {(mode === 'sign-up' || mode === 'sign-in') && <label>Password<input name="password" type="password" autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} required minLength={mode === 'sign-up' ? 12 : undefined} maxLength={128} /></label>}
        <button className="primary" disabled={busy}>{busy ? 'Working…' : mode === 'sign-up' ? 'Create account and send verification' : mode === 'reset' ? 'Send password reset link' : mode === 'verify' ? 'Send verification link' : 'Sign in to account'}</button>
      </form>
      {providers.length > 0 && <div className="toolbar">{providers.map(provider => <button key={provider} disabled={busy} onClick={() => run(async () => { checked(await authClient.signIn.social({ provider, callbackURL: '/account' })); })}>Continue with {provider === 'google' ? 'Google' : 'GitHub'}</button>)}</div>}
    </>}
    {message && <p className="notice" role="status">{message}</p>}{error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}
