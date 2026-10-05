# Operations and encrypted backups

Status: implemented and verified locally. Public deployment, production restore
drills, live worker monitoring and operational staffing are unverified.

## Operator authority and abuse review

`NEEDWARE_OPERATOR_ACCOUNTS` is a comma-separated list of at most 16 exact
verified account UUIDs. Missing, malformed, duplicated or oversized lists fail
closed. `/api/operations` requires a verified session created in the last 15
minutes, the configured allowlist, exact request origin and existing account
rate limits. A client cannot supply an operator identity or bypass these checks.
The `/operations` consumer panel uses the same API. Account switches clear its
state; expired authority clears previously displayed operational information.

Verified accounts report a published entry using one of four bounded reasons:
harmful content, privacy, spam or copyright. The service stores no free-form
report text, screenshots, email addresses or device secrets. Reports are
deduplicated per account/entry, limited to 10 per day and 128 retained reports
per account. Reports do not automatically remove an application. Operators
explicitly review them and act against the current entry version.

Hiding, restoring, inspecting, account holds and retained-job retries are
transactionally coupled to an operator audit record. Failed audit writes roll
back the corresponding change. Moderation increments the entry version so a
stale publication or operator review fails its CAS. Owner updates preserve the
moderation flag. Public discovery, stable and pinned metadata/download requests,
and remix-source lookup independently enforce moderation. Owners retain their
definition, encrypted data and export access. Copies already downloaded cannot
be recalled. Audited operator inspection exports only deliberately published
signed definitions; it cannot open encrypted private entries or user state.

Creation holds use the same account lock as generation, billing checkout and
registry publication. A hold blocks new creation, dispatch, publication and
checkout, hides the account's shared entries, and requests cancellation of
running jobs. Undispatched queued work fails without provider cost when claimed.
Already dispatched requests can incur cost; their known or conservative usage
still settles, without replay. Cancellation, existing data, encrypted sync,
exports, account deletion and the owned billing portal remain available.
Existing subscriptions are not silently cancelled by moderation; the consumer
can manage/cancel them in the billing portal. Releasing a hold requires its
current version and does not clear an individual entry's moderation flag.

Reports cascade with deleted accounts/entries. Reviewed reports and pseudonymous
operator audit metadata expire after 30 days; active holds remain until explicit
review or account deletion. No private application content is included in audits.

## Durable worker operations

Email, generation and billing workers report their independent instance/state
every five seconds. A role is healthy only when a running instance reported
within 30 seconds. Stopping one replica does not hide another live replica;
required configured roles that never report are unhealthy. Instance records
expire after one day. Health is process liveness, not proof of email delivery,
provider quality, paid entitlement correctness or production acceptance.

Private operations show bounded open reports, recent audits, holds, current
worker health and queue/dead-letter counts. After fixing configuration, a fresh
operator can explicitly retry an unleased, unexpired retained email job, or an
unfinished billing event/customer cleanup bound to the original Stripe account
and mode. The operation preserves identity/payload/expiry and atomically resets
its retry counter with an audit containing a reference digest. Completed, changed,
leased, expired or differently bound jobs reject retry. A dispatched generation
job is never included in this retry API. Its unknown cost requires review.

Run migrations before starting the three workers. Operators must inspect
dead-letter counts and actual external delivery; a heartbeat alone is insufficient.

## Authenticated backup and restore

Use a separate random 32-byte hexadecimal `NEEDWARE_BACKUP_KEY`, held outside the
backup artifact and separately from application/signing credentials. Lost keys
make these artifacts unrecoverable. This encrypts a PostgreSQL server snapshot;
it does not escrow the user's private document/recovery keys.

`node scripts/backup.mjs backup /absolute/path/snapshot.needbk` runs a PostgreSQL
18 custom-format dump and streams it through AES-256-GCM. A fresh 96-bit nonce
and versioned header are authenticated, with a 128-bit tag and 16 GiB bound.
No plaintext dump is written to disk. A unique mode-0600 temporary artifact is
flushed and changed to mode 0400 before atomic publication without overwriting
an existing destination. Warnings or failed dumps prevent publication. Only
bounded buffers are used; credentials and provider errors do not enter output.

`node scripts/backup.mjs restore /absolute/path/snapshot.needbk` uses
`DATABASE_URL` as the **separate empty target**, never the live source database.
It copies the encrypted source into a private temporary directory, authenticates
the complete snapshot while discarding plaintext, then checks target emptiness.
Only after successful authentication does it stream a second decryption into
`pg_restore --single-transaction --exit-on-error`. No clean, drop, replace or
create-database flag exists. Occupied targets are refused; SQL failures roll back.
The temporary snapshot remains encrypted and is removed after the operation.

Native PostgreSQL client tools must be installed for remote operation. Passwords
are passed through the child environment, never command arguments. Remote
database connections require certificate-verified TLS and explicit
`NEEDWARE_DATABASE_CA_PEM`. The explicit `--local-container` option supports only
the loopback development service on port 55432 with its pinned PostgreSQL 18
container. It cannot redirect a remote database operation into that container.

Only trusted operator snapshots may be restored. PostgreSQL archives contain
server schema/function definitions and are not an untrusted import format.
Source: [PostgreSQL dump](https://www.postgresql.org/docs/18/app-pgdump.html),
[atomic restore](https://www.postgresql.org/docs/18/app-pgrestore.html),
[TLS verification](https://www.postgresql.org/docs/18/libpq-ssl.html),
[Node authenticated decryption](https://nodejs.org/api/crypto.html#decipherfinaloutputencoding).

## Evidence and production limits

`pnpm test:operations` uses independent real local accounts/PostgreSQL/browser
sessions: unauthorized/foreign/stale operators, CSRF/canonical field checks,
private inspection denial, reporter limits/deduplication, audit rollback,
publisher CAS/moderation persistence, pinned downloads/owner exports, account
holds and generation usage settlement, replica health and retained email retry.
`pnpm test:billing` additionally verifies account holds preserve portal access,
and operator retries bind retained billing/cleanup jobs to the original merchant
and mode. Its external service remains an authored Stripe fixture.

`pnpm test:backup` creates two disposable databases. An actual encrypted dump
restores accounts/password hashes, vault roots, devices, members and encrypted
chunks exactly. Wrong keys, header/nonce/cipher/tag mutation, truncation and
symlinks fail before target writes. Read-only SQL restore fails atomically;
occupied targets and duplicate artifact publication preserve existing data.
The original database and original project working directory remain untouched.

Production backup storage/retention, key custody, deletion reconciliation after
restoring an older snapshot, RPO/RTO measurement, alerts and live recovery drills
must be configured and verified before public production acceptance. A local
dump drill does not establish these outcomes. Restored databases must remain
isolated from production traffic/workers until deletion and billing state are
reconciled with the current external records and operational deletion ledger.
