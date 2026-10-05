import Link from '../offline-link';
import { authConfigured } from '../../lib/auth-options';
import AccountPanel from './panel';
export const dynamic = 'force-dynamic';
export default async function AccountPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const initialError = (await searchParams).error ? 'This account link is invalid or expired. Request a new link below.' : '';
  const providers = (['google', 'github'] as const).filter(provider => Boolean(process.env[`${provider.toUpperCase()}_CLIENT_ID`] && process.env[`${provider.toUpperCase()}_CLIENT_SECRET`]));
  return <><header><Link href="/">needware /</Link><span>Your account</span><Link href="/billing">Billing and your plan</Link></header><main id="main" className="account-page">
    <h1>Your Needware account</h1><p>Use your account across devices. Your local applications remain available without signing in.</p>
    {authConfigured() ? <AccountPanel providers={providers} initialError={initialError} /> : <p className="notice">Accounts are not configured on this installation. <Link href="/">Continue with local applications</Link>.</p>}
    <p>Encrypted data needs a trusted device or your recovery code. Resetting your login password does not recover encryption keys.</p>
  </main></>;
}
