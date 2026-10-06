# Deno compatibility and deployment gates

Needware has not been deployed to Deno Deploy. This is a compatibility probe,
not production acceptance or an approved replacement for the Linux supervisor.

Run after building the native release gateway, browser WASM, Next.js production
bundle, and authored compiler fixture:

```sh
python3 scripts/token_guard.py run 'npx --yes deno@2.9.6 run --no-config --no-lock --node-modules-dir=manual -A scripts/verify-deno-compatibility.mjs'
```

The probe uses ephemeral loopback ports and fixture credentials, excludes inherited
production configuration, terminates its child processes, and retains bounded
diagnostics in `.logs/` and a receipt in `artifacts/deno-compatibility.json`.
It tests native subprocess startup, private compilation authorization, authored
fixture compilation, WASM signature verification and tamper rejection, application
TypeScript module loading, and production Next.js HTTP startup. It does not call
a model, migrate a database, send mail, create payments, or deploy cloud resources.

## Account observations: 2026-10-06

The authenticated `needware-gautam` organization was created without adding a
payment method. Its dashboard reports Free Plan, $0/month, unverified, with:

- 10,000 HTTP requests, 0.2 CPU hours and 3.5 GiB-hours memory per billing cycle.
- 1 GiB outbound traffic, 768 MB runtime memory and no custom domains.
- Five apps, two apps with cron jobs, five-minute builds and 3,072 MB build memory.

These account values take precedence over the larger advertised verified Free
allowances. No app, paid subscription or payment method was created. Do not
upgrade or add a card automatically. Official billing documentation says free
organizations pause at exhausted quotas rather than incur overage charges.

## Gates before adoption

1. Verify the account's billing and privacy terms, including data-processing
   arrangements; the current pricing page does not list a DPA for Free.
2. Verify native Linux artifact compatibility, exact release provenance, private
   gateway lifetime, request cancellation, and memory/CPU usage in a hosted probe.
3. Adapt workers to bounded invocations without losing database leases, durable
   retries, cancellation, reconciliation, or encrypted result delivery. The
   current persistent polling loops must not be deployed unchanged.
4. Preserve schema/checksum, backup/restore, origin, ingress and signing checks;
   perform actual database, email, model and public browser acceptance.

The local probe does not establish any of these hosted production gates. Keep
Cloudflare and Netlify as alternatives rather than weakening a gate to fit Deno.

## Secret-free hosted probe preparation

CI packages `deno-host-probe-<commit>` from six explicit allowlisted files after
the native compiler and WASM fixture checks pass. The package includes a hash
receipt and refuses unexpected files or symlinks. Its entrypoint `probe.mjs`
requires a clean Linux build for hosting, verifies every file, and runs one
bounded authored fixture through a private loopback gateway with ephemeral
credentials. It checks anonymous rejection, SSE compilation, package signatures
and tamper rejection, then stops both child processes.

Only `GET /health` exposes the sanitized result; all other routes return 404.
There is no public compilation endpoint, database, model key or persistent
worker. Upload only the exact verified CI artifact, never the checkout or
`.local/`. GitHub app installation alone does not create a Deno deployment;
local upload needs separate CLI authorization and a reviewed public-probe action.
This probe cannot establish real model quality, durable worker recovery, mail,
backup/restore, account acceptance or production readiness.

Sources: [Deno runtime support](https://docs.deno.com/deploy/migration_guide/),
[billing changelog](https://docs.deno.com/deploy/changelog/),
[pricing](https://deno.com/deploy/pricing).
