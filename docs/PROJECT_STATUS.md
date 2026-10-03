# Implementation evidence

Statuses describe actual code and checks, not planned completeness.

| Area | Status | Evidence / remaining work |
|---|---|---|
| Workspace and bounded-output tooling | VERIFIED | Rust format, Clippy, tests, credential-pattern scan and toolchain doctor pass locally |
| Scoped capability authorization | VERIFIED | Two tests pass: default denial/revision isolation and network scope/escalation rejection |
| IR, expressions, validation | IMPLEMENTED | Canonical Rust/TS/schema, bounded evaluator and reference/data validation; full static typing/derived fields pending |
| Declarative migrations | NOT_STARTED | IR operations represented; no executable migration engine yet |
| Signed packages and crypto primitives | VERIFIED | Ed25519 known vector, AEAD context separation, duplicate JSON rejection, arbitrary-byte property test, package tamper/untrusted-signer tests |
| Native transactional runtime | VERIFIED | Add/toggle/delete, snapshot restore, invalid field rejection and failed-sequence rollback; overlay/back/effect completion pending |
| Native SQLite | VERIFIED | Durable reopen, namespace isolation, compare-and-swap conflict and delete tests |
| WASM boundary | VERIFIED | Same Rust add/toggle behavior executes in Chromium, Firefox and WebKit; unsupported renderer features fail before startup |
| Browser host/renderer/PWA | IMPLEMENTED | Twelve three-engine journeys pass locally and in [Linux CI](https://github.com/Gautam2117/needware/actions/runs/37138464605): durable mutation/reopen with actual server stopped, malformed input rejection, stale-write rejection, leader takeover and repeat opens. Channels bind to loaded runtime instances. Chromium/Firefox use SQLite/OPFS; macOS WebKit uses explicit IndexedDB fallback. Complete renderer families, temporary mode, quota/corruption recovery UX, installation and exact devices pending |
| Compiler/provider adapters | IMPLEMENTED | Six Rust compiler tests exercise all four adapters through local HTTP contracts, acyclic schema projection, independent acceptance tests, bounded repairs, refusal, usage and cancellation. Nine three-engine browser cases cover disclosed fixture compilation, signed package review/WASM execution, cancellation and CSRF. Local Axum gateway authorization/capacity tests pass; 18 Rust tests total. Real model calls, semantic quality corpus, account quotas, durable jobs and hosted signing remain unverified or pending. See [compiler development](development/compiler.md) |
| Accounts, cloud sharing, history | NOT_STARTED | Approved architecture |
| Encrypted sync, collaboration, recovery | NOT_STARTED | Approved architecture |
| Billing, relay, operations, deletion | NOT_STARTED | Approved architecture |
| Deployment/device/provider acceptance | NOT_STARTED | No production claims |

Fixture credentials and fixture applications are never production evidence. Real integrations are marked externally blocked only after their executable boundary exists and the missing prerequisite is identified.
