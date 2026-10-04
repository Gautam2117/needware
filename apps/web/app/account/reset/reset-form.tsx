'use client';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { authClient } from '../panel';
export default function ResetForm() {
  const token = useSearchParams().get('token'); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [done, setDone] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!token) return;
    const form = new FormData(event.currentTarget);
    if (form.get('password') !== form.get('confirm')) { setError('Passwords must match.'); return; }
    setBusy(true); setError('');
    try {
      const result = await authClient.resetPassword({ token, newPassword: String(form.get('password')) });
      if (result.error) setError(result.error.message || 'The reset link is invalid or expired. Request another.'); else setDone(true);
    } catch { setError('Account service unavailable. Try again.'); } finally { setBusy(false); }
  }
  if (!token) return <p className="notice error">This reset link is incomplete. <Link href="/account">Request another link</Link>.</p>;
  if (done) return <p role="status">Password updated and previous sessions revoked. <Link href="/account">Sign in</Link>.</p>;
  return <form onSubmit={submit} className="account-form"><label>New password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
    <label>Confirm password<input name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
    <button className="primary" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>{error && <p role="alert" className="notice error">{error}</p>}</form>;
}
