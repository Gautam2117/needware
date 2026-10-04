# Accepted root authority and document epochs

Native/WASM protocol and atomic local multi-document publication implemented
2026-10-04. Atomic account-root cloud publication remains outstanding.
This decision does not establish complete account-device revocation.

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
browser must remain selected. This does not yet establish cloud publication.

Server verification uses actual Rust-generated public vectors, both signatures,
canonical encoding, exact context and independent current authority. Tests reject
signature-byte mutation, replay, account substitution and malformed public keys.
The Rust tests and three-engine WASM tests also verify preserved source state,
retained-device checkpoint installation, historical access and new recovery.
The full local regression passes 87 native tests, ten server proof tests,
66 browser cases and nine compiler fixtures; dependency audits pass. Actual
PostgreSQL acceptance passes the complete account/relay corpus, selected-device
epochs, fault/nonce/quota boundaries and immutable recipient-certificate archives.

The remaining account operation must publish all owned-document cuts, current
account pin, selected device certificates/approvals and new recovery together.
The browser must durably stage its complete intent and commit root/journals
atomically. Foreign-owned shared documents require their owners to create fresh
keys; future publication must pause until those owners approve the corresponding
cuts. Removing grants alone cannot establish cryptographic exclusion for them.
Revocation cannot erase data that an authorized device previously downloaded.
