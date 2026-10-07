# Bounded scheduled workers

Continuous CLI workers retain their existing behavior. After applying migration
`0011-scheduled-workers.sql`, a scheduler can import `runMailWorker` and
`runGenerationWorker` from their existing scripts and invoke each with
`{once: true, reuseResources: true, scheduleSeconds: 300}`. Each call processes
at most one eligible job and retains shared database/mail resources for the next
call. Importing a worker does not start its loop. Queue leases, cancellation,
durable retry, encrypted generation delivery and unknown-usage handling remain
in the existing implementations. Reusable calls require bounded execution.

Set `NEEDWARE_WORKER_MODE=scheduled` and
`NEEDWARE_WORKER_INTERVAL_SECONDS=300` consistently on web, scheduler and
preflight processes. Cashfree billing also supports bounded `runBillingWorker`
invocations; Stripe billing remains continuous. See [Cashfree activation](cashfree.md)
for its separate host and real payment qualification gates. A successful bounded tick records `idle`
and stops its health timer. Readiness accepts only the latest scheduled report,
the configured interval and a completion within that interval plus 60 seconds.
Future timestamps, stale active heartbeats, stopped or degraded reports fail.
An empty mail tick preserves earlier transport degradation; actual successful
delivery clears it. Operations and production preflight use the same predicate.

`pnpm test:scheduled-workers` and `pnpm test:scheduled-workers:deno` use fresh,
disposable local databases and local mail only. They verify reusable execution,
signal cleanup, durable mail failure/retry/recovery, clock and schedule checks.
Reported tick CPU timings exclude startup and do not establish hosted CPU or
memory consumption, runtime retention between cron invocations, or availability.

This code does not provision a scheduler or establish production readiness.
Before deployment, measure the exact Linux artifact, startup frequency, complete
job CPU/memory/bandwidth and actual account quotas. Keep one production schedule;
staging timelines must not process production queues. Require public account,
mail and generation acceptance before release. Do not enable paid fallback to
make resource or readiness checks pass.
