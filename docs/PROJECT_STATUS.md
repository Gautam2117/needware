# Implementation evidence

Statuses describe actual code and checks, not planned completeness.

| Area | Status | Evidence / remaining work |
|---|---|---|
| Workspace and bounded-output tooling | VERIFIED | Rust format, Clippy, tests, credential-pattern scan and toolchain doctor pass locally |
| Scoped capability authorization | VERIFIED | Two tests pass: default denial/revision isolation and network scope/escalation rejection |
| IR, expressions, validation | IMPLEMENTED | Canonical Rust/TS/schema, bounded evaluator, checked text serialization, pre-copy materialization accounting, stable numeric/time sorting and reference/data validation; full static typing/derived fields pending |
| Declarative migrations | IMPLEMENTED | Native review/apply/rollback CLI; same-app/parent/revision checks, exact-state review digest, bounded deterministic add/rename/remove/transform operations, destructive consent, target-state validation and atomic SQLite snapshots. Seven new tests cover CLI round trip, stale review, failed writes, rollback, fuel and expanding defaults. Six three-engine browser cases cover destructive consent, preserved records/defaults, atomic package/state history, offline reopen/rollback, stale review and wrong-parent rejection. Browser quota/fault injection and synchronized schema epochs remain pending |
| Signed packages and crypto primitives | VERIFIED | Ed25519 known vector, AEAD context separation, duplicate JSON rejection, arbitrary-byte property test, package tamper/untrusted-signer tests |
| Native transactional runtime | VERIFIED | Add/toggle/delete, snapshot restore, invalid field rejection, failed-sequence rollback and shared per-event fuel exhaustion rollback across nested, conditional and parallel groups; overlay/back/effect completion pending |
| Native SQLite | VERIFIED | Durable reopen, namespace isolation, compare-and-swap conflict, atomic revision snapshot/update failure injection, rollback retention and cascade deletion tests |
| WASM boundary | VERIFIED | Same Rust add/toggle behavior executes in Chromium, Firefox and WebKit; validated 10,000-record snapshots larger than the 2 MiB IR ceiling reopen through the separate 16 MiB state decoder on all three engines, and invalid restores preserve state; unsupported renderer features fail before startup |
| Browser host/renderer/PWA | IMPLEMENTED | Twelve three-engine journeys pass locally and in [Linux CI](https://github.com/Gautam2117/needware/actions/runs/37169199463): durable mutation/reopen with actual server stopped, malformed input rejection, stale-write rejection, leader takeover and repeat opens. Channels bind to loaded runtime instances. Chromium/Firefox use SQLite/OPFS; macOS WebKit uses explicit IndexedDB fallback. Complete renderer families, temporary mode, quota/corruption recovery UX, installation and exact devices pending |
| Compiler/provider adapters | IMPLEMENTED | Six Rust compiler tests exercise all four adapters through local HTTP contracts, acyclic schema projection, independent acceptance tests, bounded repairs, refusal, usage and cancellation. Nine three-engine browser cases cover disclosed fixture compilation, signed package review/WASM execution, cancellation and CSRF. Local Axum gateway authorization/capacity tests pass; 31 Rust tests total. Real model calls, semantic quality corpus, account quotas, durable jobs and hosted signing remain unverified or pending. See [compiler development](development/compiler.md) |
| Accounts and cloud sharing | NOT_STARTED | Approved architecture; local revision recovery history is implemented above |
| Encrypted sync, collaboration, recovery | NOT_STARTED | Approved architecture |
| Billing, relay, operations, deletion | NOT_STARTED | Approved architecture |
| Deployment/device/provider acceptance | NOT_STARTED | No production claims |

Fixture credentials and fixture applications are never production evidence. Real integrations are marked externally blocked only after their executable boundary exists and the missing prerequisite is identified.
