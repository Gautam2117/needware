# Billing authority and durable entitlements

Stripe 23.0.0 is pinned to API `2026-09-30.endive`. Configuration selects an exact
Stripe account ID, secret key mode, signed webhook secret and approved monthly
recurring price. The SDK retrieves its own account before creating checkout or
processing billing work. Customers, webhook receipts and deletion jobs retain
their exact merchant/mode binding. Public HTTPS installations cannot obtain Pro
quota from an unrelated merchant, a test-mode row or an unbound entitlement.

Verified accounts review the server-retrieved amount/currency and automatic
renewal before checkout. Supported configured currencies are USD/INR/EUR/GBP.
The client cannot select another price or another customer's portal. Owner locks
and stable request IDs serialize checkout. A durable intent fixes expiry and
request parameters before the external SDK call, allowing retry after a lost
response with the same Stripe idempotency key. Pending checkout is recoverable
after browser reload. Existing subscriptions and simultaneous checkout attempts
require portal management. Only exact HTTPS Stripe checkout/portal destinations
are accepted. Payment details never enter Needware's forms or database.

Checkout return does not grant access. Webhooks use bounded original bytes,
maintained SDK signature verification, a bounded signature timestamp and exact
mode checks. Unsupported connected-account events are rejected. Acknowledgment
follows durable receipt insertion; only minimal object/customer/merchant IDs and
an identity digest are retained. Duplicate event IDs do not enqueue twice;
reusing an ID for a different identity is rejected.

Stripe does not guarantee event order. The leased worker therefore retrieves
current subscription, invoice, payment and charge state. One active approved
subscription and its exact item/price/quantity/period must have a paid current
invoice and compatible payment evidence. Refunds, unresolved disputes, actionable
fraud warnings, changed prices/identities, unpaid invoices and expired periods
prevent paid access. Won disputes may restore it after current-state validation.
Subscription/entitlement updates and receipt completion share a transaction;
failed writes preserve the receipt for retry. These choices follow Stripe's
[webhook guidance](https://docs.stripe.com/webhooks) and
[subscription guidance](https://docs.stripe.com/billing/subscriptions/webhooks).

Periodic reconciliation repairs lost events. Pro entitlement snapshots must be
refreshed within thirty minutes and remain inside their paid period; an outage
fails closed to Free creation limits. Higher limits apply to newly authorized
requests. Existing reserved requests and imported applications retain their
previously authorized state; ending a subscription never deletes application
data. Calendar-month provider-cost quotas are separate from subscription charges.

Account deletion transactionally enqueues the exact billing customer under its
original merchant/mode before removing account records. The deletion worker
retries a stable customer deletion and confirms completion. Stripe
[customer deletion](https://docs.stripe.com/api/customers/delete) cancels active
subscriptions and removes saved payment details; processor payment history has
its own retention. Pending cleanup cannot be treated as complete under another
merchant or key mode. Consumer deletion disclosure states that cancellation is
scheduled. Failed/dead-letter cleanup requires operational attention before
production release.

`pnpm test:billing` runs the actual Stripe SDK against a conspicuously authored
HTTP contract fixture inside a guarded disposable local database. Public origins,
live credentials and non-disposable databases cannot enable the fixture. The
suite uses real verified Needware accounts and consumer UI, but no Stripe account,
card or money. It exercises consent/price/ownership/origin, lost response and
reload retry, signatures/limits/replay/order, current paid-state validation,
refunds/disputes/fraud, stale/merchant/mode denial, transactional retries and
subscription deletion after account removal. Real Stripe sandbox, live payment,
tax/account setup and production reconciliation remain unverified without the
owner's Stripe configuration.
