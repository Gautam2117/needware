# Durable hosted generation and encrypted delivery

Verified accounts submit canonical, bounded requests with a stable UUID, explicit
provider consent and their current registered encryption-device certificate.
The exact provider/model/endpoint, installation signer, configured token rates
and cost ceiling are pinned to the request. Policy changes require another
review. Installation-owned provider credentials stay in the private Rust
gateway; anonymous web compilation is restricted to explicit loopback fixtures.
Real installations require a persistent 32-byte signing seed. Restart cannot
silently change application signing authority.

PostgreSQL owner locks serialize idempotency, concurrent/daily/monthly request
limits, entitlement expiry and reserved-cost budgets. Enqueue and reservation
share a transaction. An identical retried UUID returns the original job; changed
content or another owner cannot reuse it. At most two active requests per account
are allowed. Free quotas are three requests/day, twenty/month and $10 provider
cost/month; the configured Pro entitlement permits fifty/day, two hundred/month
and $100 provider cost/month. These are internal provider-cost ceilings, not
card charges. Billing activation still requires its own verified integration.

The worker claims bounded leases and records dispatch before invoking the private
gateway. A crashed pre-dispatch lease may be reclaimed. A dispatched request with
unknown completion is never automatically executed again: its reserved ceiling
settles conservatively and usage is explicitly marked unknown. Cancellation,
device removal, changed root certificates and account deletion stop result
publication. Known token usage and actual/conservative cost settle atomically
with the result; unknown usage never masquerades as measured token usage.

Only bounded, natively validated signed packages from the pinned installation
signer become results. Native HPKE binds each result to the exact account, job
and requesting device under a separate cryptographic domain. The server stores
ciphertext and bounded metadata. The trusted opaque-key worker decrypts and
revalidates signatures before displaying signer/permission review. Saving creates
an encrypted application through the existing durable journal. Other enrolled
devices cannot decrypt a job result until its application has been imported and
deliberately synchronized. Losing the requesting device before import loses the
result; recovery of an account alone cannot recreate that device's private key.

Descriptions are plaintext queue inputs needed by the reviewed provider. They
are cleared on every terminal transition. Queued requests expire after 24 hours.
Result storage reserves the full 4 MiB package bound for active jobs, charges
bounded record metadata and enforces 128 MiB per account. Completed job history
and results expire after 30 days through bounded, owner-locked cleanup; usage
ledgers remain. Expired-result HTTP reads stop even before cleanup. Imported
encrypted application data is separate and is preserved. Consumer disclosure
states retention and device restrictions before use and in the job history.

`pnpm test:generation` uses a conspicuously authored local HTTP provider fixture,
real verified accounts, PostgreSQL, private Rust compilation and native browser
decryption. It covers concurrent UUID retry, transactional enqueue failure,
quota/reservation/token settlement, queued and running cancellation, crash
recovery, no dispatched replay, device removal, entitlement expiry, storage
limits, result expiry/pruning, account deletion, consumer creation/history,
permission review/import and cold reopen. Three-engine adversarial HPKE tests
cover wrong device/account/job and tampered ciphertext/package. This is local
integration evidence, not real model quality, billing or production acceptance.
