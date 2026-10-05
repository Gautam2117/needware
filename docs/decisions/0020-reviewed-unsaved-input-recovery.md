# Reviewed unsaved input recovery

Typed input drafts live in the isolated trusted renderer. They are separate from
durable application state and encrypted synchronization journals. Needware sends
only a bounded count and pending-action count to the shell during ordinary editing.
It does not persist plaintext drafts automatically or send them to the service.

Application replacement, deletion, local rollback and shared revision activation
query the current renderer before changing the active application. Pending actions
block replacement; unsaved inputs require an explicit discard confirmation.
Shell links receive the same guard. Browser reload/close uses `beforeunload` while
inputs or actions remain pending. Browsers can suppress that prompt, and mobile
termination or process crashes cannot be intercepted. Browser history traversals
handled entirely by a client router are not guaranteed to issue `beforeunload`.
Decision 0022 switches application entry/exit links to full HTML and verifies real
browser Back/Forward warnings. These warnings are not a durable draft store.

An explicit export produces a clearly disclosed plaintext recovery file. The file
binds to the signed package digest and local application identity, or to the exact
encrypted account/document identity. Import rejects other bindings/revisions and
existing dirty drafts. Each field must exist on the currently projected screen,
including inactive tab panels; users must open the original screen first for
offscreen fields. Decision 0022 adds an explicit per-screen recovery preview for
files spanning screens; unavailable fields are never dropped automatically.
All selected fields stage before any draft changes. Limits are 4096 fields,
8 MiB recovery representation and 4 MiB raw editing data. Native input contracts
parse recovered text; invalid text remains visible and cannot submit an older value.
Every recovered input requires explicit saved-value/draft review before submission.
Import does not modify saved state or bypass native action/capability checks.

Action requests carry fresh renderer identifiers. Durable success acknowledgments
clear only captured drafts whose raw value still matches the submitted input.
Later edits remain dirty and receive normal saved-value conflict review. Failure,
timeout and stale renderer responses cannot mark input saved. The frame bounds
pending actions to 32 and shell recovery requests to eight with five-second timeouts.

Three-engine acceptance exercises canceled application/link replacement, saved-state
separation, explicit export/import, wrong-revision rejection, atomic malformed-field
rejection, invalid raw decimal recovery and text edited while an earlier save is
delayed, plus rejected cross-tab durable writes retaining exportable drafts. Real mobile termination recovery and durable encrypted draft storage remain
open; do not describe these warnings as protection against process loss.
