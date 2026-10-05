import { Suspense } from 'react';
import Link from '../../offline-link';
import ResetForm from './reset-form';
export default function ResetPage() {
  return <><header><Link href="/">needware /</Link><Link href="/account">Your account</Link></header><main id="main" className="account-page"><h1>Set a new password</h1>
    <Suspense fallback={<p role="status">Loading password reset…</p>}><ResetForm /></Suspense>
  </main></>;
}
