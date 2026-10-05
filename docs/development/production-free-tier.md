# Free infrastructure and payment release status

Verified on 2026-10-06. Infrastructure spending authorization is zero.

Oracle's current [Always Free limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
include two AMD 1 GB micro instances, or ARM A1 allocation within 2 OCPUs and
12 GB memory, and 200 GB combined boot/block storage in the home region.
Capacity is not guaranteed; idle instances can be reclaimed. Free hosting does
not establish production availability, tested backups, or release acceptance.

The authenticated Mumbai tenancy already has two running micro instances.
Neither is authorized for replacement or development. Console usage showed
zero of two ARM OCPUs used, zero of 12 GB ARM memory used, and 94 GB of 200 GB
storage used. A separate Ubuntu 24.04 ARM Needware host with a 50 GB encrypted
boot volume fits that allocation. Both 2 OCPU/12 GB and 1 OCPU/6 GB creation
attempts returned `Out of capacity for shape VM.Standard.A1.Flex` in AD-1,
with Oracle choosing the fault domain. No host deployment or acceptance passed.
Do not fall back to paid shapes or a paid account upgrade.

The local deployment SSH key is retained privately under ignored `.local/`.
Only its public key was entered into the console. Before any successful host
deployment, verify actual inventory, storage usage and network rules; restrict
SSH to the administrator's source and expose only HTTP/HTTPS for the application.
Keep PostgreSQL and the Rust gateway private, as required by the existing host
procedure. Build and verify the exact release for Linux ARM on the target.

## Payment authority

The owner requested Razorpay or Cashfree instead of a Stripe production account.
The existing Razorpay dashboard shows approved KYC and subscription navigation;
this does not prove that Needware's software service or hostname is approved.
The existing business may have a different approved activity. No merchant
settings, plans, subscriptions, credentials or transactions were changed.

[Razorpay terms](https://razorpay.com/terms/) prohibit processing transactions
outside the approved business profile and require prior written permission for
materially changed products/services. Keep Needware live billing disabled until
the provider approves the truthful Needware offering under the correct business
and merchant authority. A separate account is an option subject to onboarding,
not a way to bypass approval. Cashfree also requires merchant onboarding.

Payment processing is not universally free: published
[Razorpay](https://razorpay.com/pricing/) and
[Cashfree](https://www.cashfree.com/payment-gateway-charges/) fees apply to
successful payments according to the merchant agreement. Promotional eligibility
must be confirmed for the specific account. Setup must not initiate real charges.

The repository currently implements Stripe billing and rejects missing merchant
bindings. A verified Razorpay/Cashfree port must preserve reviewed price binding,
account isolation, authenticated durable webhooks, reconciliation, cancellation,
refund/dispute handling and deletion cleanup. Merely changing environment variable
names or attaching a hosted payment link is not completed integration.

## Remaining release gates

Free host capacity; approved Needware merchant integration; verified DNS, mail
transport and sender; an authorized model endpoint with truthful cost/rate policy;
production schema/build/supervision preflight; exact-commit CI; real production
acceptance. None may be inferred from successful local fixture tests.
