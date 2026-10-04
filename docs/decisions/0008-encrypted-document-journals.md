# Atomic encrypted document journals

Accepted 2026-10-04. Private runtime sessions use the existing nonextractable
WebCrypto account storage key and the same IndexedDB database as root/device
backups. Version 2 upgrades the previous vault database without changing its
key or backup bytes. Document records bind account UUID, document UUID and
generation in domain-separated AES-GCM metadata.

The journal contains the verified package, holder-root-wrapped document key,
owner membership/pin, roster, authenticated shared history, device-local state,
pending ciphertext uploads and relay cursor. Device-local state is never sealed
under the shared document key or included in synchronization frames. Reopening
replays signed history before accepting a local snapshot; its synchronized
projection must match that history exactly. A recovered/new device still needs
a document grant signed for its own device identity.

Each action or received batch runs on a fresh opaque WASM session. Rendering,
signature/scope validation and encryption precede a single durable transaction.
The transaction checks both root and document generations and updates account
quota accounting. Only after success does the host publish the new session/view,
return effects, remove acknowledged uploads or advance the cursor. A failed
write preserves the original session, queue and cursor. This host rejects remote
effects before committing until their durable execution lifecycle is implemented.

Limits: 32 MiB plaintext per journal, 128 MiB aggregate ciphertext per account,
256 documents. Native history/frame limits apply independently. Quota exhaustion,
tab races, ciphertext tampering and root-backup races fail closed. Browser
storage eviction remains possible; local journals are not cloud backups.

`/encrypted` runs a dedicated trusted worker and the existing opaque-origin
renderer. App frames receive only views and validated events, never vault handles,
keys, journal bytes, queues or account API credentials. Local-only applications
can use this encrypted storage without declaring collaboration. Nonempty shared
scopes still require explicit collaboration and synchronized storage permission.

Cloud document relay, device/root revocation, synchronized revision migrations,
history compaction and public deployment remain separate unfinished gates.
