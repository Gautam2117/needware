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
| Browser host/renderer/PWA | IMPLEMENTED | Local three-engine journeys pass: durable mutation/reopen with actual server stopped, malformed input rejection, stale-write rejection and leader takeover. Linux WebKit CI exposed a frame handshake race; load-bound channels and runtime instance checks added. CI rerun pending. Chromium/Firefox use SQLite/OPFS; macOS WebKit uses explicit IndexedDB fallback. Complete renderer families, temporary mode, quota/corruption recovery UX, installation and exact devices pending |
| Compiler/provider adapters | NOT_STARTED | Approved architecture |
| Accounts, cloud sharing, history | NOT_STARTED | Approved architecture |
| Encrypted sync, collaboration, recovery | NOT_STARTED | Approved architecture |
| Billing, relay, operations, deletion | NOT_STARTED | Approved architecture |
| Deployment/device/provider acceptance | NOT_STARTED | No production claims |

Fixture credentials and fixture applications are never production evidence. Real integrations are marked externally blocked only after their executable boundary exists and the missing prerequisite is identified.
