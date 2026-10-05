# Production preflight

Run from the canonical release checkout with Node 24. Production secrets must
be injected by the host or supplied through a private env file:

```sh
node --env-file=/etc/needware/production.env scripts/production-preflight.mjs
node --env-file=/etc/needware/production.env scripts/production-preflight.mjs --online
```

No `.env` or `.local/dev.env` is loaded implicitly. Exit 0 requires every
check to PASS, including online checks. Offline-only success is UNVERIFIED.
Reports contain issue identifiers, never secret values or upstream error text.

The gate checks:

- Canonical public HTTPS origin, authenticated PostgreSQL/TLS, SMTP/TLS,
  independent signing/auth/backup/control secrets, explicit provider rates,
  live Stripe configuration and verified operator identities. Fixtures and
  acceptance databases are rejected.
- Build receipt: current source bytes, Next server/static output, browser/WASM
  workers and SQLite/offline assets. Next's mutable `server/route-cache/` is
  excluded; immutable server code remains hashed. `pnpm build` records the receipt only after
  all build steps succeed. Modified or missing outputs fail verification.
- SQL migration receipts and live catalog fingerprint, including columns,
  defaults, constraints, indexes, triggers and row-security policy. The reviewed
  migration command records receipts after successful completion. Existing
  applied-file checksum mismatches or catalog drift abort before migrations run. A database
  without receipts requires the reviewed migration command; preflight never
  installs or repairs schema.
- Email, generation and billing worker heartbeats within 30 seconds, and
  configured operator accounts that exist and have verified email.
- SMTP authentication/TLS handshake without sending mail; authenticated private
  gateway policy matching the installation signer, provider, model and rates.
- Stripe key/account and active live monthly price binding using the existing
  billing validation; charge/payout readiness and an enabled webhook with the
  pinned API version and every event consumed by the billing reconciler.
- Public HTTPS response and required security headers, with redirects rejected.

Database probes run inside an enforced read-only transaction with a statement
timeout. External operations are GET requests or SMTP verification. No customer
rows are changed, jobs dispatched, emails sent, checkouts created, or charges made.

Preflight is a readiness gate, not production acceptance. It cannot prove email
delivery/inbox placement, webhook secret correctness/delivery, real model quality,
payments, restore from an independently retained backup, device installation or
human acceptance. Those require separate recorded production journeys.

The selected topology is one Linux host, HTTPS ingress, loopback-only Node/Rust
services, PostgreSQL and supervised persistent workers. Infrastructure must
provide private environment injection, persistent backups and service supervision;
a web deployment alone does not supply the gateway or workers.

Verification: `pnpm test:preflight`, `node scripts/verify_schema_readiness.mjs`
(disposable local PostgreSQL only), then a fresh `pnpm build` and
`node scripts/verify_build_readiness.mjs`. The latter temporarily corrupts and
restores generated/source fixture bytes; run before consumer acceptance starts.
