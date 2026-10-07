# Netlify native worker qualification

The Ubuntu GNU release at `a9dfdbc` fails native startup on the actual Netlify
preview with `GLIBC_2.38`. HTTP and local Deno success do not establish host fit.
The diagnostic preview uses authored fixtures and an expiring credential; it
contains no account, SMTP, model or installation signing credentials.

Linux host probes now use `x86_64-unknown-linux-musl`. Packaging rejects an ELF
interpreter or shared-library dependencies, records the target and exact file
hashes, and preserves the clean-source release receipt. CI runs the native
fixture/signature/tamper checks before browser suites and uploads that artifact.
Clean release `aee9eca` passed actual Netlify Linux/x64 Node24.21 ordinary
and background probes: native startup, anonymous compiler401, fixture SSE,
WASM signature and tamper rejection. Background logs measured1290.25ms and
188MB peak usage, with1024MiB allocated. This is authored-fixture compatibility.

The separate real DB/SMTP empty-queue probe passed cold/warm certificate-verified
connections and bounded mail dispatch, with no email sent. It measured2659.76ms
and1546.45ms of work at1024MiB allocated. The canonical account installation later
passed real signup and email verification; its automatic scheduled retry reported
healthy idle execution at2026-10-07T11:45:26.988Z. Verified operator access passed
against the published source `46b9647`; generation remains disabled.

Account mail runs once after committed auth responses; a protected HTTP endpoint
drains one retry every15minutes. Netlify's scheduled function invokes that endpoint
with a separate dispatch credential and a25second request deadline. Persistent
polling is absent. Local acceptance verifies delivery, retry authentication,
concurrent leases and scheduled health. The cron and HTTP function both consume
compute; using2.7seconds per invocation estimates45credits/month for idle retries
on a31day month. This is a measured estimate, not a guaranteed upper bound.
The300credit Free cap is shared by all nine sites, including bandwidth/deploys;
exhaustion pauses sites and cannot be treated as unlimited production capacity.

Node CPU/RSS excludes child process usage; captured child high-water RSS was
about61MiB for the fixture provider and7MiB for Rust. Keep generation disabled
until real model quality, durable free quotas and hosted lifecycle tests pass.
