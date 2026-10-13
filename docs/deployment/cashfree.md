# Cashfree billing activation

## One-time Pro passes (current launch path)

Cashfree has refused Subscriptions for the current merchant profile. Its active
Payment Gateway is separate. Use `NEEDWARE_BILLING_MODE=cashfree_once` only after
written product/domain scope confirmation and real financial acceptance. Never
reuse subscription approval flags as gateway approval.

The pass is INR499 total for exactly 720 hours from verified successful captured
payment time, with no mandate or automatic renewal. New orders are blocked while
a pass is unexpired or another checkout remains pending. Apply migration0014
after an encrypted backup and verified repeat migration on an isolated restore.
Server credentials stay private. `CASHFREE_PG_LIVE_APPROVED` confirms provider
scope; `CASHFREE_PG_ACCEPTANCE_APPROVED` is allowed only after actual checkout,
payment, signed webhook, refund/dispute, expiry and lost-event acceptance.

For the actual human payment trial before public acceptance, set only the
reviewed account ID in `CASHFREE_PG_ACCEPTANCE_ACCOUNT`, with absolute
`CASHFREE_PG_ACCEPTANCE_STARTED_AT` and `CASHFREE_PG_ACCEPTANCE_UNTIL` timestamps
spanning at most30minutes. This still requires provider scope approval and live
credentials. Only that verified account can test checkout/entitlement while
hosted creation is paused; its UI explicitly discloses a real test charge.
All other users remain blocked. Remove the window after the trial; never use
this exception to imply public availability or skip financial acceptance.

Order creation durably binds owner, merchant, mode, price/contact review and UUID
before provider dispatch. Retries resume the same order. Raw signed notices only
suspend stale access and queue reconciliation; SDK redirects grant nothing.
Reconciliation verifies exact order/customer/currency/amount, a single captured
success, all refunds and disputes. It stores an immutable payment/start/end and
enforces30-minute snapshot freshness. Unknown identity, partial refund, pending
refund, unresolved dispute and provider failure keep access at Free. Deleted
accounts cannot transfer orders to a new account. The scheduled worker handles
durable retries and periodic reconciliation for missed events.

Public `/pricing`, `/terms`, `/privacy`, `/refunds` expose product facts and a
seven-day refund policy with support through gautam@continuumarc.tech. Refunds
are reviewed and processed by the operator through Cashfree; no automatic refund
or financial-action execution is claimed. `pnpm test:billing:orders` proves
authored responses with disposable real PostgreSQL, not provider acceptance.
Keep production billing disabled until the above gates and generation capacity
qualification pass. The global free inference ceiling remains unchanged.

## Legacy subscription adapter (not approved for this account)

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
`billing-retry` packages a direct Netlify scheduled invocation every five
minutes, with a shared 20-second provider deadline and a 24-second database
deadline. Each query has a one-second timeout. Its hosted execution and queue
capacity still require actual qualification.
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

## Activation after Cashfree approval

Keep `NEEDWARE_BILLING_MODE=disabled` until Payment Gateway and Subscriptions
are both approved. Inject production credentials as server secrets; test keys
cannot activate production. Set `CASHFREE_ENVIRONMENT=production` and
`CASHFREE_LIVE_APPROVED=1`, then run `pnpm billing:cashfree:prepare` in the
server-secret environment. It verifies or idempotently creates the exact ₹499
monthly plan. It creates no subscription or charge and does not enable billing.

Payment Gateway activation does not activate Subscriptions. If plan creation
returns `profile_inactive`, open Subscriptions in the merchant dashboard and
complete Request Activation. Keep `CASHFREE_LIVE_APPROVED=0` until that profile
is active; a successful authenticated plan lookup alone is insufficient.

Configure the signed webhook above. Qualify actual authorization, successful
CHARGE, refund/dispute revocation, cancellation and duplicate/out-of-order/lost
event recovery before setting `CASHFREE_LIVE_ACCEPTANCE_APPROVED=1`. Enable
`NEEDWARE_BILLING_DISPATCH_MODE=scheduled` with a fresh private dispatch token,
then set `NEEDWARE_BILLING_MODE=cashfree` only when hosted generation is ready.
Redeploy after server environment changes and verify the deployed values.

The protected `POST /api/internal/billing` endpoint accepts `{}` and a bearer
`NEEDWARE_BILLING_DISPATCH_TOKEN` for manual recovery. The scheduled function
runs directly without paying for a second HTTP invocation. Both preserve the
durable retry lease on failure. A temporary `NEEDWARE_BILLING_HOST_PROBE=1`
with `NEEDWARE_BILLING_HOST_PROBE_UNTIL` at most 30 minutes in the future
performs a certificate-verified read-only schema check with no provider calls.
The probe expires automatically; remove both settings after qualification. Do not leave the probe enabled during billing.

The five-minute schedule makes 288 invocations per day even while disabled.
Measure its execution time and the shared Netlify credit balance before enabling
billing; no paid upgrade is authorized. For rollback pause new creation and keep
reconciliation/cancellation running for existing subscriptions. Preserve billing
rows, signed receipts and encrypted backups. Never change merchant/provider
identity to bypass an existing pending subscription.
