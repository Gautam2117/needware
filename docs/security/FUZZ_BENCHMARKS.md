# Bounded native fuzzing and local baselines

The standalone `fuzz/` workspace pins libfuzzer-sys 0.4.13 and commits its lockfile.
Run `CARGO_BUILD_JOBS=2 python3 scripts/run-fuzz-acceptance.py --seconds 60` through
the token guard after installing cargo-fuzz 0.13.2 and nightly-2026-10-04.
The default stable toolchain remains unchanged.

The runner seeds only authored public control, widget, visual and typed-effect fixtures. It
never reads user applications, account keys, recovery codes or private states.
Signed-package decoding, duplicate-rejecting strict IR/state/event JSON, and
native rejected-event/restore/page/checkpoint/completion state-and-view invariants execute with AddressSanitizer.
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

After the cross-screen input metadata changes, the 13:36 UTC campaign recorded
signed_package 2,712,539 executions / 512 MiB peak RSS; strict_json 509,385 / 544 MiB;
runtime_transaction 21,154 / 503 MiB. All three passed: 3,243,078 executions with
the same bounds and no detected crash, sanitizer, unit-timeout or rollback failure.
Logs are `.logs/fuzz-20261005T133607Z-*.log`. The subsequent local release medians
were 417.542 microseconds for verification, 5.250 for projection, 6.750 for dispatch
and 388.209 for strict 4 MiB decoding. These receipts retain the limitations above.


After bounded pagination, the 15:04 UTC campaign recorded signed_package
2,622,196 executions / 502 MiB peak RSS; strict_json 456,735 / 536 MiB;
runtime_transaction 21,516 / 506 MiB. All three passed: 3,100,447 executions
with the same bounds and no detected crash, sanitizer, unit-timeout or rollback
failure. Page requests preserve document state and rejected requests preserve
serialized views. Logs are `.logs/fuzz-20261005T150414Z-*.log`. The subsequent
release baseline, measured after sanitizer completion, had medians 379.167
microseconds for verification, 4.958 for projection, 6.583 for dispatch and
386.625 for strict 4 MiB decoding. These remain local microbenchmarks.


After typed effect completion, the 17:14 UTC campaign recorded signed_package
2,633,638 executions / 520 MiB peak RSS; strict_json 512,465 / 522 MiB;
runtime_transaction 20,834 / 528 MiB. All three passed: 3,166,937 executions
with unchanged bounds. The added public effect corpus exercises authenticated
checkpoint derivation and one-shot typed outcomes; rejected restore/completion
preserves document state, view and pending intents. Logs are
`.logs/fuzz-20261005T171455Z-*.log`. The idle post-campaign release baseline had
medians 382.959 microseconds for verification, 5.042 for projection, 6.583 for
ordinary typed dispatch and 387.542 for strict 4 MiB decoding. It does not measure
external API or effect-journal latency. The limitations above still apply.
