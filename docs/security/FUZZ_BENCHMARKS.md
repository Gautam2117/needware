# Bounded native fuzzing and local baselines

The standalone `fuzz/` workspace pins libfuzzer-sys 0.4.13 and commits its lockfile.
Run `CARGO_BUILD_JOBS=2 python3 scripts/run-fuzz-acceptance.py --seconds 60` through
the token guard after installing cargo-fuzz 0.13.2 and nightly-2026-10-04.
The default stable toolchain remains unchanged.

The runner seeds only authored public control, widget and visual fixtures. It
never reads user applications, account keys, recovery codes or private states.
Signed-package decoding, duplicate-rejecting strict IR/state/event JSON, and
native rejected-event/restore state-and-view invariants execute with AddressSanitizer.
Campaign limits are 1 MiB input, five seconds per input and 1 GiB RSS. The explicit
2 MiB IR and 16 MiB state boundary tests remain separate: the campaign does not
claim to fuzz every production-sized input. Larger/longer campaigns, independent
review and real multi-replica/production load acceptance remain open.

`artifacts/fuzz/acceptance.json` records toolchain, bounds, execution counts, elapsed
time, RSS and log paths. Failure units stay under `fuzz/artifacts/`. CI runs the same
three targets for 20 seconds each and archives receipts, logs and failure units for
14 days. The standalone lockfile receives RustSec, license, source and wildcard
dependency checks with no advisory ignores. The exact development-only libfuzzer-sys
0.4.13 license allowance is NCSA; other crates/versions retain existing policy.
The pinned crate declares its LLVM source license in README, and the conditions
are published by [SPDX](https://spdx.org/licenses/NCSA.html). The harness is outside
the production workspace and does not ship in the runtime/web application.

`cargo run --release -p xtask -- benchmark` writes
`artifacts/benchmarks/native-baseline.json`. It warms each operation three times,
records individual samples and reports median, p95 and maximum nanoseconds with
architecture, OS and build profile. Operations are signed widget-package verification,
native typed-widget projection, a repeated deterministic typed action, and strict
decoding of a synthetic 4 MiB state string. The decode measurement does not include
application-specific state validation, encryption, database persistence or rendering.
These microbenchmarks are local observations, not browser/mobile latency, service
capacity, an SLA or a production throughput estimate. CI archives its own baseline;
no machine-specific latency threshold pretends to establish production readiness.

Local recorded campaign, 2026-10-05: signed_package: 2,452,554 executions, PASS, strict_json: 420,934 executions, PASS, runtime_transaction: 21,045 executions, PASS. No crash, sanitizer failure, per-input timeout or runtime invariant failure was detected in this bounded run. Reported peak RSS stayed below the 1 GiB cap.
