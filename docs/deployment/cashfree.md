# Cashfree billing activation

Cashfree is selected explicitly with `NEEDWARE_BILLING_MODE=cashfree`. Stripe
remains available with `stripe`; `disabled` rejects checkout and webhook work.
The shared billing-account row pins one provider, merchant namespace and mode.
Switching providers requires review of the existing subscription, including a
confirmed cancellation; changing configuration cannot create a second account.

The reviewed initial Pro price is ₹499 each month; Free is ₹0. Cashfree's active
periodic INR plan must match that price and monthly interval exactly. Checkout
uses the official hosted SDK, a durable UUID and an owner-bound subscription.
The phone goes to Cashfree; Needware stores a digest of contact/price review.
A ₹1 authorization is refundable and never activates Pro. First charge is
scheduled 48 hours after checkout creation. Expired or cancelled intents cannot
be reopened; a pending subscription must be cancelled before another is created.

Apply `0013-cashfree-billing.sql` before deploying these routes. The migration
extends the existing billing identity constraints and adds durable checkout,
event, payment-mapping and deletion/cancellation queues. Run the migration twice
in an isolated restore before production; take an encrypted production backup.

Configure signed Subscription events and `PAYMENT_SUCCESS_WEBHOOK` at
`https://needware.continuumarc.tech/api/billing/webhook`. The latter supplies a
candidate merchant order ID for the subscription transaction. Subscription
`cf_payment_id` and gateway transaction `cf_txn_id` are different identifiers.
Fresh API reads must verify the subscription, exact plan, successful CHARGE,
merchant order, gateway transaction, all order refunds and payment disputes.
Missing order mapping, missing API coverage, ambiguous identity, stale state,
refunds or unresolved disputes keep access at Free. Checkout return is no proof.
Raw-body HMAC verification has a five-minute timestamp window and a 256 KiB
bound. Durable receipt insertion precedes acknowledgment. A new signed notice
suspends stale paid authority; duplicate processed receipts do not revoke it.

`pnpm billing:worker` runs the selected provider. A scheduler may import
`runBillingWorker` with `{once:true,reuseResources:true,scheduleSeconds:300}`;
Cashfree processes at most one event, cleanup and periodic account per tick.
This interface is implemented; its Netlify hosting, invocation deadline, queue
capacity and shared Free-credit consumption still require actual qualification.
Keep billing disabled until that host gate passes. Failed leases retain bounded
retry state; account deletion retains a cancellation job without the deleted
user's contact information. Paid access requires a snapshot under 30 minutes old.

Use private server settings from `.env.example`. The merchant namespace is
`cf_` plus the first 32 hex characters of SHA256(client ID), identifying a
credential scope, not asserting Cashfree's legal merchant identity. Live keys
and merchant/Subscriptions approval are required. `CASHFREE_LIVE_APPROVED=1`
and `CASHFREE_LIVE_ACCEPTANCE_APPROVED=1` are operator approvals only after
actual charge, refund, cancellation, duplicate/out-of-order/lost-event and
production activation acceptance. Sandbox rows never grant Pro on public HTTPS.
ContinuumArc product categories and each payment website require provider review;
this integration does not establish blanket approval for every product.

`pnpm test:billing:cashfree` exercises authored provider responses with real
isolated PostgreSQL. It proves local trust boundaries, not real payment
acceptance. Real sandbox API plan/create/replay/cancel checks have passed, but
hosted checkout showed provider maintenance and no CHARGE/refund proof exists.
Production billing and generation remain disabled. The hard global Cloudflare
free inference budget is unchanged regardless of paid subscription revenue.
