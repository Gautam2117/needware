# Authorized ciphertext relay

Accepted 2026-10-04. The Next account service stores private package ciphertext in
immutable 1 MiB PostgreSQL bytea chunks and authenticated encrypted Automerge frames
as bounded canonical JSON. This avoids a second object-store dependency for the
initial bounded deployment. PostgreSQL backup/restore must cover these objects.
The server holds public identity/binding/grant metadata and opaque encrypted key,
configuration and package envelopes. It never receives the account root,
document key, recovery code, plaintext package or device-local application state.

Every private object read/write/download/grant uses a maintained verified account
session, exact-origin request, registered encryption-device certificate, one-use
session-bound expiring challenge and device signature over the canonical payload
digest. Document grants are independently verified against the stored owner root
pin, key/schema epochs, document identity, generation, recipient public identity
and read/write role. Login possession cannot enroll a device or replace a pinned
root. Account/document deletion and device certificate loss deny new requests.

Package chunks and manifests are immutable. Finalization checks complete ordered
chunks, exact byte count and SHA-256 ciphertext digest. Frame SHA-256 deduplication
and monotonically increasing sequence cursors are transactional. The client still
authenticates/decrypts every frame and original writer through Rust/WASM before
advancing its durable cursor. The relay cannot inspect encrypted CRDT operations.
Malformed authenticated ciphertext can halt a receiver; quarantine/operator repair
and complete malicious-writer availability handling are unfinished.

Account storage limits are 128 MiB of retained bytes, 256 documents and 256 members
per document. Package ciphertext is bounded to 32 MiB plus AEAD overhead; individual
requests/responses are capped, package chunks are 1 MiB, frames are 2 MiB and history
is 100,000 relay entries. Native operation/history limits apply separately. Quota
accounting commits with object writes under PostgreSQL locking. Idempotent retries
do not charge retained objects twice. Package upload checkpoints, outgoing frames
and receive cursors remain in encrypted browser journals until durable completion.
Each membership records its exact canonical metadata charge. Device/account
cascades refund that charge while preserving other document objects; document
deletion refunds its remaining ledger exactly once.

The trusted worker imports cloud data into a staged session, verifies its owner
pin and encrypted configuration, then requires package signer/permission review
before saving/running it. Owner recovery can unwrap the owner-held document key
under a trusted recovered account root and issue a fresh grant for that registered
device. A foreign collaborator needs a new explicit owner grant. Sharing uses
recipient certificate files and encrypted HPKE offers; account identifiers/public
device keys are disclosed, email addresses are not needed by the document protocol.

Synchronization is opt-in per document. The browser retries enabled documents on
reconnect with jittered exponential backoff and honors rate-limit Retry-After.
Authorization failure asks for sign-in/device-grant review. Local edits remain
usable and durable while the relay is unavailable. Already saved applications
can run offline; fresh authentication, cloud import and key enrollment require
connectivity. Login/password reset cannot recover encryption material.

Document re-keying and bounded compaction use the
[atomic cloud epoch protocol](0011-atomic-cloud-document-epochs.md). It resets
collaborator grants under an independent fresh document key and retains encrypted
archives. Account-root/device revocation, selected remaining-recipient rewrapping
and synchronized revision review/rebase remain unfinished. A previously authorized device retains copies it already downloaded;
future ciphertext exclusion requires a new independent document key. Public
deployment, real mail/provider acceptance and exact physical devices are separate
gates, not established by local/CI acceptance.
