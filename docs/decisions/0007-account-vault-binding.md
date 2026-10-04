# Account-bound vault identity and recovery

Status: accepted and implemented locally; cloud rotation/document relay remain open.

Use the maintained Better Auth user UUID as the account-root namespace. A verified
login can read the account's public identity, device certificates and encrypted
recovery envelope. It cannot replace an existing root or approve an encryption
device on its own. Initial root registration requires an owner-signed device
certificate and proof of possession of that device's private signing key.

The trusted Rust/WASM vault signs domain-separated `AccountOperation` records.
Each record binds account/root context, device public keys, operation, a server
challenge UUID and SHA-256 of the exact canonical payload. The server uses Node's
maintained Ed25519 verification and RFC 8785 canonicalization; cross-language
acceptance runs the actual Rust-produced bytes through that verifier. This is
application/device authorization, not a replacement for maintained login auth.

Challenges belong to one authenticated session/account/operation, expire after
two minutes and are consumed in the same PostgreSQL transaction as the write.
Account locking serializes initial root pinning and device limits. Device changes
require a login created within fifteen minutes. Canonical request bodies reject
duplicate keys, extra fields, oversized inputs, malformed identities and keys.
Authenticated requests have an atomic account rate limit. Ten devices and ten
pending challenges are explicit bounded limits in this version.

Initial setup persists an encrypted local vault before publishing its public
identity. The user must confirm saving the recovery file outside the browser.
Only the encrypted recovery envelope is uploaded; the code/root never enter an
API body. Root pins are immutable in this version. A different new root under the
same login is rejected. Local/cloud identity mismatch preserves local keys.
Recovery cryptographically verifies the recovered authority; trusted enrollment
uses an explicitly approved, recipient-bound signed HPKE file. Unenrolled device
keys also persist encrypted, so reloading does not invalidate their requests.

Local backups use non-extractable WebCrypto keys and IndexedDB compare-and-swap.
Opening is coordinated with Web Locks where supported. A committed cloud write
whose HTTP response was lost is resolved from the pinned public device record
before retry. Account deletion cascades hosted public identity/recovery records.
Saved files/local applications remain; session revocation does not itself rotate
encryption roots/document keys. Full future-access device revocation depends on
the atomic root/document rotation transaction still to be implemented.

Protocol canonicalization uses the maintained
[RFC 8785 reference implementation](https://github.com/erdtman/canonicalize).
