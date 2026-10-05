# Encrypted local raw draft recovery

The encrypted application host captures raw, unsubmitted inputs into the existing
client-encrypted document journal. Document state and signed synchronization frames
remain unchanged. Snapshot writes use the same account-root generation, document
CAS, quota and atomic encrypted transaction as the runtime journal. Package binding
uses the native verified package digest. Pending key transitions reject mutations.
A raw edit on an old schema remains private recovery data; it never becomes an
old-schema application write or a stale-key synchronization frame.

Each opaque-frame connection gets a fresh editing-session identity. Reopening a
page with no edits cannot overwrite earlier snapshots. Snapshots retain invalid
raw strings, booleans and selection lists without coercion. Baseline application
values are omitted. Each snapshot has at most 4096 inputs and the existing 4 MiB
raw editing bound. At most eight snapshots fit in an 8 MiB aggregate envelope;
full recovery storage rejects new writes and retains originals. No eviction is
implicit. Other writers, malformed inputs, wrong digests, stale removals and failed
persistence preserve the live view, original snapshots and upload queue.

Autosave debounces by 500 milliseconds and reports success only after the encrypted
transaction resolves for the same draft version. Before that confirmation, abrupt
termination can still lose recent input. Failures keep input visible and exportable.
Browser storage eviction/removal can destroy local recovery; this feature is not
a cloud backup or physical-device acceptance. Saved drafts remain unsubmitted data.

Recovery lists current and retained-history snapshots. A user explicitly selects
and reviews recovery before submitting a form. Unavailable screen/page inputs stay
in the recovery source; partial import requires explicit screen-by-screen review.
Earlier package digests are exportable and cannot be silently mapped to the current
schema. Recovery never executes an application action automatically. Current local
snapshots can be removed only with explicit confirmation and matching generation;
newer edits remain preserved. Retained epoch history keeps its original snapshot.
Plaintext export is labeled and requires explicit confirmation.

Existing root rotation and document deletion now include private drafts because
all draft data is inside the encrypted journal. No independent storage key or
plaintext fallback is introduced. A late writer cannot recreate a deleted journal.
Cloud package/configuration/checkpoint and signed-frame paths do not include draft
snapshots. Acceptance checks unchanged upload queues and absence of raw request
payloads, cold reopen, invalid raw editing, explicit review, failed commits, snapshot
bounds, stale removal and actual root rotation/history retention in all three engines.

Local applications still use explicit plaintext recovery export; they do not claim
this encrypted autosave path. Production, physical-device and external backup
retention/deletion reconciliation remain separately unverified.
