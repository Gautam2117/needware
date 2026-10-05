# Preserved checkout recovery review

Reviewed 2026-10-06 against canonical `effd62a`. The original
`/Users/gautamgovind/Projects/Needware` is a read-only recovery snapshot.
Comparisons used the actual file contents, not filenames or Git status counts.

| Preserved file | Classification | Evidence in canonical implementation |
| --- | --- | --- |
| `.github/workflows/core.yml` | SUPERSEDED | Every older job remains; synchronized revisions, remix, generation, controls, drafts, effects, accessibility, integrations and benchmark jobs added. |
| `crates/needware-sync/src/tests/revision_tests.rs` | SUPERSEDED | Older tests retained; adds rejection when history changes but visible state returns to its original value. |
| `docs/decisions/0012-accepted-root-epoch-chain.md` | SUPERSEDED | Older security text retained; adds exact signed schema-review boundary and disposable-database acceptance safeguards. Later decisions describe completed consumer/cloud work. |
| `package.json` | SUPERSEDED | Existing checks retained; isolated integration runners, worker commands and additional acceptance suites added. |
| `scripts/check.py` | SUPERSEDED | Older commands retained; adds runtime-frame type checking and acceptance-clock guard tests. |
| `scripts/verify_accounts.mjs` | ALREADY IMPLEMENTED DIFFERENTLY | Assertions retained; real rate-window waiting remains the fallback. Window adjustment is restricted to a fresh disposable local acceptance database. |
| `scripts/verify_cloud_roots.mjs` | ALREADY IMPLEMENTED DIFFERENTLY | Assertions retained; guarded acceptance-window helper and explicit fresh-recovery phase boundary replace repeated waits. |
| `scripts/verify_document_relay.mjs` | SUPERSEDED | Full relay corpus retained; diagnostic routing adds schema, registry, generation, billing, operations and backup suites. |
| `scripts/verify_root_ui.mjs` | ALREADY IMPLEMENTED DIFFERENTLY | UI assertions retained; fresh recovery explicitly starts after the guarded quota-window boundary. |
| `scripts/verify_roots.mjs` | ALREADY IMPLEMENTED DIFFERENTLY | Root focus retained; now enters the disposable-database account runner. |

No missing behavior was found to port. No older files were copied, staged or
modified. Keep the snapshot until deployed release acceptance and final CI pass.
