# Trusted browser vault boundary

WASM exposes `BrowserVault` and `BrowserSync` as opaque host-owned handles. Secret
account roots, device seeds and document keys are not serializable public types.
The generated application frame receives neither these handles nor their backup
buffers. Account screens now bind roots to verified Better Auth account UUIDs;
setup, recovery and HPKE device-enrollment UX pass actual three-engine local
acceptance. Live document relay integration remains unfinished.

The host explicitly approves enrollment/sharing and supplies independently pinned
account contexts/authority. Enrollment uses signed HPKE transfers; joining a
document verifies owner-signed membership and expected document/root/generation
before opening its key. A declared collaboration capability and synchronized
storage scopes are required, in addition to host consent. Runtime dispatch still
enforces action inputs and storage consent; a failed sync commit restores runtime
state before any returned platform effects can execute.

`create_recovery` returns a one-time user-held code and encrypted root envelope.
Only the envelope belongs on the service. `document_key_backup` returns an owner
wrapped document key. After original devices are lost, a new device recovers the
root using the code, restores these wrapped keys, opens the package and validates
its encrypted signed history. Original owner handles are actually freed in the
three-engine recovery test. Losing both every device and the recovery code still
makes the data unrecoverable; login/password reset is not decryption recovery.

`local_backup` returns sensitive transient bytes containing a random local device
lock and device/root/document envelopes. Encrypt them with `EncryptedVaultStore`
and wipe the buffer. Never store/upload this buffer directly. `from_local_backup`
only consumes decrypted local bytes and verifies every envelope/identity.

`openVaultStore` uses non-extractable AES-256-GCM WebCrypto keys stored through
IndexedDB structured cloning. Fresh random nonces and authenticated namespace/
generation metadata protect backup records. The transaction compares the exact
previous generation before replacing a record. Concurrent/stale writers and
corrupted ciphertext reject while retaining the stored record. It caps backup
payloads at 2 MiB. Browsers can restore the root/device after a page reload.

This protects local persistent records from casual plaintext inspection. It is
not hardware-backed key storage and does not protect against arbitrary code in
the trusted origin or a compromised logged-in OS. Origin/frame isolation remains
essential. Device passphrase/OS-lock choices and account pinning UX remain open.

Six Playwright cases across Chromium, Firefox and WebKit verify actual WASM
enrollment/pinning failures, independent collaborator merges while the actual
HTTP proxy is stopped, dedup/tamper/role failures, recovery, encrypted persistence,
non-extractability, reload, concurrent CAS and corruption rejection. These are
desktop browser-engine results, not physical-device or deployed-service evidence.
