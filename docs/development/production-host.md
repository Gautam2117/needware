# Production host and release procedure

Use one Linux host with systemd, Node 24.21.0 at `/opt/needware/node/bin/node`,
the pinned repository Rust toolchain, pnpm 11.5.3, wasm-bindgen 0.2.129, Git,
PostgreSQL 18.6 and Caddy. Only SSH and Caddy's HTTPS/HTTP ports are public.
PostgreSQL, the Node web service (3000), and Rust gateway (3001) bind loopback.
The database has a distinct production role/password/database. Development
containers, fixture credentials and local data are never deployed or copied.

The service template runs five instances: `web`, `control`, `email`,
`generation`, `billing`. Workers retain their existing durable PostgreSQL
leases/retries and heartbeats. systemd restarts failed services, bounds shutdown,
and restricts writes to Next's runtime cache directories. The private Rust
gateway is never reverse-proxied. The supervisor requires Node 24, valid
production configuration, a matching build receipt, a clean checkout and
`NEEDWARE_RELEASE_SHA` equal to actual HEAD. The control service additionally
requires the hashed native release binary.

Provisioning prerequisites:

- A host accessible through the owner's existing authenticated SSH/cloud access,
  plus DNS authority for the chosen public hostname.
- An authenticated TLS SMTP service and verified sender domain.
- An installation-owned OpenAI API credential, supported model and approved
  explicit token rates. The template chooses `open_ai`; the existing approved
  adapter supports alternatives. Do not substitute a consumer chat subscription.
- A live Stripe merchant account capable of charges/payouts, approved active
  monthly Pro price, and endpoint secret. Install the webhook at
  `/api/billing/webhook`, API version `2026-09-30.endive`, with the consumed
  events listed in preflight (or all events).
- Independently generated installation auth/control/signing/backup secrets;
  keep the backup key and encrypted backups independently retained.

Install `infra/production/production.env.example` as
`/etc/needware/production.env` owned by root, mode 600. Populate actual secrets,
origin and release SHA. The service user `needware` owns only its runtime
cache directories; release source, dependencies, `.git` and binaries remain
readable and immutable to that user. Release Git reads trust only the current checkout through command-scoped
`safe.directory`; no global ownership-check exception is installed.
Configure PostgreSQL backups with the
existing `scripts/backup.mjs backup|restore` commands and a separately retained key;
perform an empty-target restore before release.

Prepare an exact remote checkout of the canonical commit under
`/opt/needware/releases/<SHA>`; do not develop or edit it. Install frozen
dependencies and run these commands with the private production environment
injected, using the pinned tools:

```sh
pnpm install --frozen-lockfile
pnpm production:build
node --env-file=/etc/needware/production.env scripts/auth-migrate.mjs
node scripts/build-readiness.mjs
```

Before a first release, create and verify the real owner's account through an
SSH-forwarded, loopback-only Next server using this same build/environment.
Keep public ingress disabled during this bootstrap. Record the actual account
UUID in `NEEDWARE_OPERATOR_ACCOUNTS`; do not invent a UUID or mark email verified
through SQL. Stop only the owned bootstrap process before starting supervision.

Point `/opt/needware/current` at the prepared release. Create its
`apps/web/.next/cache` and `apps/web/.next/server/route-cache` directories with
write access for `needware`. Install `needware@.service`, reload systemd, and
enable/start all five service instances. Configure `NEEDWARE_PUBLIC_HOST` in
Caddy's own service environment, install the Caddyfile, validate it and start
HTTPS ingress. Caddy overwrites the private client-IP header and strips incoming
auth/platform identity headers. Only the managed loopback web service enables
the `caddy-loopback` trust mode; other runtime contexts retain conservative limits.
See [Caddy proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Run online preflight as the service user with the production environment
injected. Require all gates PASS, then separately record real production signup,
email delivery/verification, recovery, cloud sync/revision, provider compilation,
billing webhook/payment/reconciliation/deletion and backup restore acceptance.
SMTP verification and Stripe GET checks do not prove those journeys.

Do not replace an existing release until its replacement passes. Before any
future database migration, retain a fresh encrypted backup and reviewed rollback
plan; changing a code symlink does not undo database migrations.

The development recovery snapshot stays untouched. Keep the canonical branch
until deployment is stable. Then verify ancestry, safely integrate into `main`,
rerun release CI and deploy the exact final commit without rewriting history.

Local infrastructure evidence: `sh scripts/verify_production_infra.sh` validates
the unit and Caddy configuration in a disposable Linux container and exercises
real spoofed-header requests. It does not prove a production host exists or that
the systemd services run successfully on the final host.
