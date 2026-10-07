# Global free generation guard

Apply `0012-global-generation-quota.sql` through the reviewed migration command.
Free-beta production preflight now requires `NEEDWARE_GENERATION_QUOTA=cloudflare-free`,
`NEEDWARE_BILLING_MODE=disabled`, `NEEDWARE_GENERATION_MAX_TOKENS=50000`, the actual
`NEEDWARE_CLOUDFLARE_ACCOUNT_ID`, and the exact Cloudflare account OpenAI-compatible
endpoint in `NEEDWARE_LOCAL_ENDPOINT`. Only `@cf/openai/gpt-oss-120b` with explicitly
zero monetary rates/ceiling is accepted. There is no paid provider fallback.
Set `NEEDWARE_APPLICATION_FORMAT=canonical`. Free-mode compiler startup uses
4,096 output tokens/request and at most one repair; direct unbounded compilation
is disabled on that gateway.

The default global allowance is 8,000 neurons/day, account allowance 4,000/day,
global concurrency two and account concurrency one. Environment overrides can
only lower these bounds. A row's existing daily ceiling cannot be raised by a
restart. Existing per-account creation count, storage and consent checks remain.

At dispatch, one PostgreSQL transaction locks the current job, reserves both
today and the next UTC day, and marks dispatch. This protects in-flight work at
midnight. The conservative reservation uses the full 50,000-token compiler ceiling
and the higher [official input/output neuron rate](https://developers.cloudflare.com/workers-ai/platform/pricing/):
68,182 neurons per million output tokens, yielding 3,410 neurons/job. Known usage
reconciles with input/output rates 31,818/68,182, rounding upward. Next-day capacity
is released only when a known result settles before midnight. Unknown usage,
interrupted work and expired reservations retain the complete charge. Expiry
releases concurrency after 240 seconds; it does not authorize replay or a refund.

The private bounded compiler endpoint rejects a compiler token ceiling above
the reservation before inference. The existing Rust per-call byte/token accounting,
180-second overall deadline, bounded repair and strict validation/signing remain.
Quota rows are independent of account/job deletion. Settled reservation metadata
expires after two days, with bounded pruning during dispatch; past daily rows
are pruned only after their protected periods. All replicas must use the
same database and exclusive Cloudflare inference account; external callers,
older deployments and restored databases cannot be covered by this ledger.
Before enabling after a restore or manual trials, reconcile the actual account's
remaining allowance and lower the daily cap accordingly. Do not run another
inference process outside this guard or enable prepaid AI Gateway billing.

`pnpm test:generation:global-quota` uses a disposable loopback database and makes
zero model calls. `pnpm test:generation` also verifies atomic dispatch rollback,
the actual bounded worker and refusal before any fixture inference on exhaustion.
Fixture usage is not Cloudflare quality or hosted resource evidence. Production
schema migration, provider qualification, hosted worker measurement and public
account/product acceptance remain required before enabling creation.
