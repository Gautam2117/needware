# Netlify native worker qualification

The Ubuntu GNU release at `a9dfdbc` fails native startup on the actual Netlify
preview with `GLIBC_2.38`. HTTP and local Deno success do not establish host fit.
The diagnostic preview uses authored fixtures and an expiring credential; it
contains no account, SMTP, model or installation signing credentials.

Linux host probes now use `x86_64-unknown-linux-musl`. Packaging rejects an ELF
interpreter or shared-library dependencies, records the target and exact file
hashes, and preserves the clean-source release receipt. CI runs the native
fixture/signature/tamper checks before browser suites and uploads that artifact.
This does not qualify Netlify until the exact artifact is deployed and measured.

Ordinary/background runtime, allocated memory, cold/warm duration and billed
compute remain separate evidence. Node CPU/RSS excludes child process usage;
child `VmHWM` and actual host metrics are required. Keep generation disabled
until real model quality, durable free quotas and hosted lifecycle tests pass.
