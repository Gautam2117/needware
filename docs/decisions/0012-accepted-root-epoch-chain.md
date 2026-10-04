# Accepted root authority and document epochs

Native/WASM protocol boundary implemented 2026-10-04. Atomic account-root cloud
publication and durable multi-document browser publication remain outstanding.
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

Server verification uses actual Rust-generated public vectors, both signatures,
canonical encoding, exact context and independent current authority. Tests reject
signature-byte mutation, replay, account substitution and malformed public keys.
The Rust tests and three-engine WASM tests also verify preserved source state,
retained-device checkpoint installation, historical access and new recovery.
The full local regression passes 87 native tests, seven server proof tests,
60 browser cases and nine compiler fixtures; dependency audits pass. Actual
PostgreSQL acceptance passes the complete account/relay corpus, selected-device
epochs, fault/nonce/quota boundaries and immutable recipient-certificate archives.

The remaining account operation must publish all owned-document cuts, current
account pin, selected device certificates/approvals and new recovery together.
The browser must durably stage its complete intent and commit root/journals
atomically. Foreign-owned shared documents require their owners to create fresh
keys; future publication must pause until those owners approve the corresponding
cuts. Removing grants alone cannot establish cryptographic exclusion for them.
Revocation cannot erase data that an authorized device previously downloaded.
