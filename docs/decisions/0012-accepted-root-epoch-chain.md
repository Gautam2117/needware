# Accepted root authority and document epochs

Native/WASM protocol and atomic local multi-document publication implemented
2026-10-04. Atomic account-root cloud publication passes real local PostgreSQL
acceptance on 2026-10-05. Consumer controls are implemented and under verification.
Public deployment and synchronized revision/rebase remain separate gates.

An account root transition has the existing old-authority signature and a new
acceptance signature over that complete signed transition. Verification against
the independent old pin authenticates the new authority. Verification against the
independent current pin authenticates the historical authority for a newly
recovered device. Exact account identity and one-step epoch advancement are
required; neither signature can substitute for the independent account pin.

Cross-root document checkpoints carry this accepted transition. Separate native
preparation, cut verification and installation paths authenticate both roots.
The ordinary same-root installer rejects cross-root checkpoints. The checkpoint
retains the exact source history digest and original author archive, while the
fresh baseline is authorized by the new root. No stale source history is silently
replayed into the new generation.

The browser owns an opaque rotation candidate. Preparing it preserves the live
source vault and copies the device identity. Historical held document keys can be
rewrapped under the new root without exporting plaintext keys. Explicit recipient
offers use the staged fresh document key. Recovery under the new root uses a new
recovery envelope and code; old codes and old document keys fail independently.

The trusted host stages a bounded encrypted intent under the existing
nonextractable local key. Its authenticated metadata binds the complete source
journal generations and rotation identity. Pending bytes count toward the account
quota; ordinary writes cannot alter the source cut. One IndexedDB transaction
publishes the new native vault, every encrypted journal and the quota ledger.
Source, root and intent conflicts abort the entire transaction. Cancellation
refunds the intent while preserving originals. Three-engine tests inject a
failure after the first journal write, then restart offline and publish all
journals together. Historical wrapped keys change holder root while original
authorship, signed frames and the old upload queue remain in the archive.

Retained browsers verify the accepted forward transition against their own old
pin before opening the signed HPKE approval. The opaque candidate preserves the
live source. Server approval validation authenticates native HPKE attestations
and admits only explicitly selected, existing device public keys; the current
browser must remain selected. A whole-account publication lock serializes root
changes with relay/device writes before any row locks are acquired.

Server verification uses actual Rust-generated public vectors, both signatures,
canonical encoding, exact context and independent current authority. Tests reject
signature-byte mutation, replay, account substitution and malformed public keys.
The Rust tests and three-engine WASM tests also verify preserved source state,
retained-device checkpoint installation, historical access and new recovery.
The full local regression passes 87 native tests, ten server proof tests,
66 browser cases and nine compiler fixtures; dependency audits pass. Actual
PostgreSQL acceptance passes the complete account/relay corpus, selected-device
epochs, fault/nonce/quota boundaries and immutable recipient-certificate archives.

`pnpm test:roots` additionally uses actual verified accounts, PostgreSQL and
independent browser keys. One transaction publishes every owned-document cut,
current account pin, selected certificates/approvals and encrypted recovery.
Missing cuts and an injected failure on the second document preserve the old
root, all current documents and quota ledger. Server activation with a lost HTTP
acknowledgment is recovered from the encrypted browser intent; one IndexedDB
transaction then publishes every local journal and the root together.

Foreign-owned shared documents retain original author certificates before device
cascades and pause uploads. Their owner must publish fresh document keys with
explicit current recipients. Actual separate-owner acceptance verifies the new
HPKE offer, original removed-author history, old-key decryption failure, denied
old-device uploads and preserved stale offline work. A service pause alone is
never reported as cryptographic exclusion. Schema/revision rebase is required
before a stale local journal can adopt a later shared generation.

Synchronized schema review now binds the verified target's exact signed parent,
trusted signers, requested scope, source binding/state/history, migration report
and materialized target state. Approval requires the exact review digest and
explicit destructive consent. The source remains intact; a fresh document key,
schema epoch and generation authenticate the target checkpoint. Ordinary epoch
installation rejects a schema cut; the explicit revision installer validates
the signed next binding and baseline before updating the receiver. Even edits
that restore identical visible state invalidate an earlier history review.
This native/WASM boundary has three-engine browser acceptance and CI coverage.
Consumer revision controls, durable cloud publication and stale-edit rebase
remain unfinished product gates.

Account/root acceptance creates a fresh randomly named local PostgreSQL database
per run and drops only that database after the test processes close. At existing
fixture wait boundaries, the harness can expire the saturated quota/challenge
window. Adjustments require a matching local URL, strict generated database name
and a matching live pool database; guard tests reject unrelated databases before
mutation. No production handler imports the helper or changes any limit. Actual
HTTP rate-limit, forwarding-header, nonce, replay and expiry assertions remain.
Revocation cannot erase data that an authorized device previously downloaded.
