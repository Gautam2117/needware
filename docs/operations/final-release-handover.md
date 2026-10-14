# Needware — production release gate and operator handover
Date: 2026-10-15

## Source-of-truth and deployment

GitHub: `https://github.com/Gautam2117/needware`, canonical deployment branch `main`. Render web service: `srv-db6v768u01pc73bnnjog`, confirmed workspace `tea-d0mvq756ubrc73eplo50`, signed in as `govindgautam933@gmail.com`. Render auto-deploy is off.

**Deployment invariant:** the Render `NEEDWARE_RELEASE_SHA` environment variable must equal the exact GitHub commit being deployed. This is deliberately fail-closed. Never trigger a new deploy first with the old SHA, or update all environment variables at once.

1. Confirm the exact main commit passes Core verification, Dependency audit and Native sanitizer fuzz. Do not deploy a red or in-progress commit.
2. On Render > needware-free > Environment, update **only** the existing `NEEDWARE_RELEASE_SHA` variable to the verified main SHA, choosing *Save and deploy*. Do not add a duplicate, overwrite other variables, or expose their values. If the API is available, use a merge-only update (`replace=false`) and observe whether it starts the deployment; avoid redundant triggers.
3. Observe the resulting Render Docker deployment until its exact commit reaches `live`. If Render returns HTTP 503, wait for the incident to clear rather than triggering a mismatched deployment or weakening the release guard.
4. Verify `https://needware.continuumarc.tech/api/health` and `https://needware-free.onrender.com/api/health` return the exact target `release`, `status=available`, `accounts=true`, `hostedGeneration=true`, `billing=cashfree_once`.
5. Smoke-check public `/`, `/pricing`, `/billing`, `/refunds`, `/privacy`, `/terms` (HTTP 200); anonymous `/api/billing` and `/api/generation/jobs` must return 401. Check the generation, email and billing worker heartbeats, pending queues, stalled encrypted packages, and backup watchdog.
6. Roll back only to the previously verified commit if this exact deployment fails; update `NEEDWARE_RELEASE_SHA` to match the rollback commit before restoring it, with no customer-data rewrites.

## Tests already performed

- Previously successful real production hosted generation of a signed device-encrypted application, signer review, local encrypted save, cloud resume/chunk/finalize/readback and reopening; no new inference is required to prove the deployment invariant.
- USB-connected physical Android Chrome: signer review, execution, local storage, reload, offline reopen and mobile layout passed. Physical iPhone is waived by the owner.
- Authenticated isolated concurrency baseline: 78 requests through up to 8 concurrent users, zero failures. This is not a sustained production load SLA.
- Rust and web unit/integration suites, compiler/proxy security cases, revision and cloud sync, quota ledger, backup and recovery, and three-engine browser acceptance were verified on earlier candidate; latest main must pass full CI again.
- Private `Gautam2117/needware-operations` repository already exists with encrypted daily recovery and recovery watchdog workflows ACTIVE. Scheduled recovery run 38529487318 on 2026-10-14 completed; artifact `needware-encrypted-recovery-38529487318` (373096 bytes, not expired). Watchdog run 38543158183 succeeded; a separate deliberate failure drill was recorded. Encrypted recovery runs with narrowly scoped environment secrets. Keep its `production-backup` `NEEDWARE_SOURCE_SHA` pinned to a CI-verified source revision and update the pin deliberately when releasing.

## Honest limits

- Internal 8,000-neuron daily shared quota and 924-neuron worst-case reservation remain; incomplete or refused model outputs are possible, and no unqualified Groq fallback is enabled. No static code audit proves a statistically robust cross-prompt success rate.
- Render Free may cold-start; no free-tier availability/throughput guarantee can be asserted. Production-wide concurrency and intentional outage drills should be performed within authorized operational and cost bounds.
- Payment scope/merchant approval remains separate and is not an acceptance claim here.
- GitHub Actions workflow success verifies tests but does not prove GitHub notification delivery to the owner if notification preferences are disabled.

## Post-handover policy

Preserve working encrypted vaults, user records, provider credentials, and all payment settings. No workarounds that suppress compiler validation, bypass signed-operation checks, inflate AI quotas, or substitute fictional production metrics. Do not label production deployed until the exact public SHA and worker health checks pass.
