# Remaining implementation dependencies

Audited 2026-10-04 against main at f82f98b and the working source. The repository
has three accepted ADRs for packages, browser persistence/frame isolation, and
reviewed revisions. Separate architecture/security folders do not exist yet.
The executable control plane currently hosts the local compiler only; PostgreSQL
and Mailpit bootstrap is infrastructure evidence, not account implementation.

1. Runtime language: explicit state/event contracts, checked decimal/date
   operations, derived fields, full action/navigation/effect lifecycle. Complete
   renderer behaviors and field bindings depend on these semantics.
2. Client cryptography: documented device/account/document key hierarchy,
   authenticated device enrollment, user-held recovery code, document key
   sharing, rotation, and bounded versioned ciphertext envelopes. Implement and
   adversarially test the approved recovery model before storing private data.
3. Local collaboration: Automerge document mapping, validated local changes,
   independent-client convergence, encrypted change/snapshot transport,
   deduplication, resource bounds and schema epochs. Browser durable journals
   and multi-writer coordination must preserve existing offline/revision behavior.
4. Cloud identity and persistence: database migrations, authentication,
   sessions/devices, CSRF/origin enforcement, email boundary, deletion, encrypted
   object storage and authorized sync relay. Authentication alone cannot enroll
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
