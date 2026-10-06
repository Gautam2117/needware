# Free beta billing boundary

Set `NEEDWARE_BILLING_MODE=disabled` on every web and worker process for a beta
that does not sell subscriptions. Leave `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID` and `STRIPE_ACCOUNT_ID` empty.
Production preflight rejects retained Stripe settings in this mode.

The disabled mode blocks Stripe configuration before checkout, portal, webhook
or billing-worker calls. Retained Pro entitlements do not increase generation
quotas; saved applications and encrypted user data are preserved. Billing
summaries hide retained customer and checkout actions. Unknown mode values
block billing and fail preflight. Omitting the setting preserves the existing
Stripe installation behavior; use `stripe` explicitly for a paid installation.

Disabled billing removes only the Stripe account/price/webhook probe and the
billing-worker requirement from production preflight. Email and generation
workers, approved provider/signing/cost policy, verified operators, database
schema, authenticated SMTP, public HTTPS and exact build artifacts remain
required. It does not make fixtures, an untested model or a frontend preview
production-ready.

This setting does not establish free hosting or free AI. Verify actual account
plans, shared quotas and absence of paid fallback separately. Exhaustion must
stop work or return a bounded unavailable response. Do not add purchased-credit
providers or upgrade hosting to make a readiness check pass.

Before enabling paid billing, obtain merchant approval, configure and verify the
exact live account/price/webhook binding, start the durable billing worker and
rerun the full production and billing acceptance gates. Do not change modes
while active paid subscriptions require reconciliation or cancellation.
