# Account service

Needware uses Better Auth 1.7.7 with its PostgreSQL adapter and maintained password,
email-token, OAuth and session implementations. Anonymous local use is preserved.
The trusted `/account` UI provides signup, verification, login, password reset,
session listing/revocation, logout everywhere and email-confirmed deletion.
Resetting a login password cannot recover client encryption keys.

Run `pnpm bootstrap`, `pnpm auth:migrate`, and `pnpm dev`. Development starts the
account migrations and durable mail worker when the local account environment is
present. Mailpit captures development messages at `http://127.0.0.1:58025`.
`pnpm mail:worker` runs the same worker independently. Reviewed auth baseline and
outbox SQL live in `services/control-plane/migrations`; native maintained migrations
reject unsafe schema changes rather than resetting data. Repeated migration does
not replace the committed baseline with empty SQL.

Verification jobs join signup's actual database transaction using Better Auth's
public transaction-context adapter. The outbox has a cascading account foreign
key, bounded fields, expiration, leases and retry state. A failed enqueue returns
503; a database refusal rolls back signup. SMTP failure keeps the committed job
for exponential retry. Delivery is at least once, so a crash after SMTP acceptance
can repeat an email. Tokens retain the framework's expiration/replay rules.

Configure `.env.example` fields for canonical HTTPS, a random auth secret,
PostgreSQL and SMTP before exposing accounts. Remote database/SMTP connections
require certificate-verified TLS; a database CA can be supplied explicitly.
Production requires a sender. Optional Google/GitHub buttons appear only when both
credentials exist. OAuth provider acceptance remains unverified without live
credentials. Auth requests require the exact canonical origin, bounded JSON,
HttpOnly/SameSite cookies and database rate limits. The supported Vercel ingress
uses its overwritten IP header only with explicit proxy configuration. Other
ingresses conservatively share a rate-limit bucket until trusted ingress is added.

`pnpm test:accounts` uses randomly named local recipients, actual Chromium,
Firefox, WebKit, PostgreSQL and Mailpit. It tests signup rollback under refused enqueue, delivery
failure/restart, verification, sessions, reset/replay, deletion and request limits.
It preserves other services, users and shared rate counters. This establishes
local account behavior. Account-bound encrypted setup, saved recovery files,
retained device keys, HPKE enrollment, recovery after key loss and root pinning are
also exercised across the three engines. See [vault identity](../decisions/0007-account-vault-binding.md).
Public HTTPS/cookies/email delivery, OAuth, device-key rotation/revocation and
encrypted document relay remain separate acceptance gates.
