# Remaining implementation dependencies

Audited 2026-10-04 against main at 271444b and the verified root-chain/selected-recipient source. The repository
has accepted ADRs for packages, browser persistence/frame isolation, reviewed
revisions, derived fields and client-owned key hierarchy. Security documents now
record the implemented vault and dependency audit boundaries.
The Rust control plane currently hosts the local compiler. The Next account
service now uses maintained Better Auth/PostgreSQL with a durable SMTP worker and
actual local browser acceptance; public integration remains unverified.

1. Runtime language: explicit state/event contracts, checked decimal/date
   operations, derived fields, full action/navigation/effect lifecycle. Complete
   renderer behaviors and field bindings depend on these semantics.
2. Client cryptography: documented device/account/document key hierarchy,
   authenticated device enrollment, user-held recovery code, document key
   sharing, rotation, and bounded versioned ciphertext envelopes. Implement and
   adversarially test the approved recovery model before storing private data.
3. Local collaboration: Automerge document mapping, validated local changes,
   independent-client convergence, encrypted change/snapshot transport,
   deduplication, resource bounds and schema epochs. Atomic encrypted browser
   journals and the dedicated encrypted worker/UI now pass local three-engine
   offline, quota, corruption and concurrency acceptance. Continue history
   account-root/device cryptographic revocation and synchronized revision
   review/rebase. Atomic cloud epoch publication now passes actual PostgreSQL
   fault/lost-ack/quota/archive tests and three-engine owner rotation/recovery.
   Owner-signed native/WASM/local journal compaction
   retains original history/tombstones and passes cold offline three-engine checks.
   Authorized ciphertext relay, durable chunk checkpoints, explicit sharing,
   reconnect/backoff and separate-account offline convergence pass locally.
4. Cloud identity and persistence: account migrations/authentication, sessions,
   origin/body/rate controls, transactional email and local deletion implemented.
   Account-bound encryption-device setup/enrollment/recovery is implemented locally.
   Authorized private package/frame storage and sync relay pass locally, including
   lost upload acknowledgments, deduplication and owner recovery on a new device.
   Selected-recipient rewrapping, immutable recipient proof archives and named-device
   rotation review now pass actual PostgreSQL/three-engine acceptance. Native/WASM
   root chains and cross-root checkpoint/recovery verification are implemented.
   Continue atomic account-root/device cloud and browser publication and
   production storage operations.
   Authentication alone cannot enroll
   a device into the encryption vault.
5. Registry and sharing: immutable revisions, private/unlisted/public URLs,
   encrypted private definitions/assets, lineage/remix, access revocation,
   reports and audited operator controls. Depends on cloud authorization and
   cryptographic sharing.
6. Hosted generation and subscriptions: durable compiler jobs, installation
   signing identity, quotas, semantic corpus, real provider checks, configured
   entitlements and verified/idempotent billing webhooks. Existing four adapter
   HTTP fixtures establish transport behavior only.
7. Consumer UI and deployment: library, sharing, recovery/device management,
   billing, responsive/accessibility checks, PWA updates and recovery UX;
   environment preflight, migration/backup/restore, observability/rate controls,
   dependency audit/fuzzing, measured benchmarks, public deployment and full
   deployed acceptance. UI flows land alongside each executable backend boundary.

All seven groups remain open. Independent infrastructure, documentation and
verification work can proceed while an external integration lacks credentials;
only an implemented and tested external boundary may be called externally blocked.
