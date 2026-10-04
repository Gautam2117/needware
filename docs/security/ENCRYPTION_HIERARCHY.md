# Client-owned encryption hierarchy

Implemented primitive boundary: `needware-vault`. Owner-signed document memberships
authorize the `needware-sync` core's read/write roles and generations. Maintained
accounts, encrypted browser vaults, account-bound cloud root pins/recovery envelopes,
device enrollment and recovery UI are now wired and tested locally. Server-side
account-root/device revocation remains pending. The authorized ciphertext document relay is
implemented and locally tested; local acceptance does not
establish deployed collaboration.

Each device holds a random 256-bit seed. Domain-separated HKDF derives distinct
Ed25519 signing and X25519 HPKE inputs. Its public identity contains a UUID and
both public keys. The account's current encryption root signs device certificates
through a separately derived account-authority key. Verifiers supply the expected
account, root epoch and pinned authority; the server cannot choose these anchors
implicitly. A verified certificate is an unforgeable Rust wrapper. Root transfer
requires a certificate for the same account and epoch.

The account encryption root is random client-generated 256-bit material. It is
never represented in a serializable/debuggable vault type. The client derives
distinct account signing and key-wrapping keys. Each document has an independent
random 256-bit data key and explicit key epoch, rather than a predictable key
derived from an old document key. Owner wraps authenticate the account/document
identity, format version, document epoch, root epoch and authority. The root only
wraps document keys; collaborators receive a selected document key.

Trusted-device enrollment and collaborator transfers use maintained HPKE 0.14.1:
RFC 9180 DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305. A fresh
system-random seed initializes the library's ChaCha20 RNG for each single-shot
encapsulation. A separate Ed25519 attestation binds the entire transfer, including
recipient device identity/keys, context, owner root epoch, encapsulation and
ciphertext. Receiving a document key cannot decode an account-root envelope.
The receiver explicitly supplies the owner's expected authority and epochs.
Recipient certificates must already have been verified against authenticated
recipient-account identity; a directory lookup alone is not that verification.

User-held recovery uses a randomly generated 256-bit code, encoded as `NW1-`,
64 lowercase hexadecimal digits, a separator and an eight-digit checksum. The
checksum detects transcription errors and is not an authentication credential.
This high-entropy code is not a user password: HKDF derives a recovery wrapping
key with account/epoch/authority context, and XChaCha20-Poly1305 wraps the account
root. Recovering verifies that the decrypted root derives the declared authority.
Only ciphertext envelopes are stored by the account service. No service recovery
secret exists. Losing every trusted device and the code makes recovery impossible.
Login/password-reset credentials cannot independently unlock the encryption root.

Document payload encryption uses XChaCha20-Poly1305 with fresh random 192-bit
nonces. Domain-separated authenticated data includes the complete document
context and bounded caller metadata; purpose/schema/revision/message identities
are supplied by the sync/private-package protocol. Payloads are limited to
32 MiB and metadata to 1 KiB. Authentication fails for modified ciphertext,
metadata or another document key. Private definitions/assets and shared state use
these envelopes at the implemented PostgreSQL storage/relay boundary; actual local
PostgreSQL checks inspect ciphertext and exercise independent decryption/merging.
Device-local state remains exclusively in encrypted browser journals. Public
production storage/acceptance is still unverified.

Local device locking is available under an independent host-held key. Ciphertext
is bound to the device identity and format version. Browser nonextractable-key
storage and account-bound backups are implemented. Login gates the trusted account
screen; unmount frees its Rust handles. Hosted root/device/recovery records cascade
on verified account deletion, while local applications and saved recovery files
remain user-owned. Secret
root/seed/code and decrypted buffers use the existing zeroizing secret wrappers.
Cryptographic dependencies own their internal temporary buffers; this is not a
promise of complete process-memory erasure. Client compromise or a malicious
delivered client can read plaintext and is outside this protection.

Root and document rotation create fresh independent secrets and increment their
epochs with checked arithmetic. Rotation must atomically publish new authority
bindings, re-enroll retained devices, replace recovery envelopes, rotate affected
document keys and wrap/share them only with retained members. The cloud layer
must enforce current epochs and membership for every upload/download. Signed authority-transition records bind the previous pinned authority to the
next account epoch/authority and reject replay or skipped epochs. Atomic account
root rotation remains unimplemented. The [cloud document epoch transaction](../decisions/0011-atomic-cloud-document-epochs.md)
stages fresh keys and resets collaborator grants. Local acceptance proves old
collaborator keys cannot decrypt the new package and old grants cannot read/write
the new relay epoch; complete selected-member/device revocation remains pending.

Revocation prevents FUTURE authorized synchronization/access. It cannot remotely
erase plaintext/encrypted copies a previously authorized device downloaded.
Retained old keys continue to open retained old ciphertext, as regression tests
explicitly demonstrate. A revoked device must never receive new root/document
keys. Ciphertext payload authentication alone does not enforce collaborator
write roles or sender identity; signed protocol frames and current authorization
are still required. Replay/deduplication and schema epochs belong to that protocol.

Exposed metadata includes account/device/document UUIDs, public keys, key epochs,
recipient relationships, ciphertext sizes and transfer timing. The service should
not learn private definition/assets/state plaintext, root secrets, document keys
or recovery codes. Fresh-device rollback protection still needs authenticated
current-epoch state; cryptography cannot detect an old valid envelope if a caller
supplies its old expected context. Existing clients must retain/pin their newest
known epochs, and the control plane must publish current authorized epochs.

Wire envelope parsing is limited to 8 KiB, rejects unknown/duplicate fields and
trailing/malformed JSON, and cryptographic opening checks exact field lengths,
versions, canonical UUIDs, contexts, epochs and signatures. Random hostile-input
property tests supplement tamper/recovery/rotation checks. Coverage-guided fuzzing,
and an independent cryptographic review remain required. Dependency audits run
locally and in CI without advisory ignores.
