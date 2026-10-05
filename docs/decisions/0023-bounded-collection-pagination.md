# Bounded collection pagination

Lists and tables expose every saved record through native pages of at most 100
records. Native view metadata reports the offset, total and page size. A cursor
selects only a currently open, enabled collection node in the verified projection;
unknown nodes, noncollections, unaligned offsets and out-of-range offsets fail.
If deletion reduces the collection, projection clamps to the last available page.
Existing evaluator, node, raster and materialization budgets still apply.

Page selection validates the complete staged view before committing transient
controls. It never changes document state, emits an effect, persists a journal or
creates an encrypted upload. Savepoints and runtime forks preserve cursors.
Encrypted hosts serialize selection and require the active schema epoch. Worker
requests also require the current application instance; the opaque-frame protocol
bounds node identities and offsets.

The renderer displays the exact record range and accessible Previous/Next controls.
Pending actions block another page request. Paging acknowledges no draft fields;
row/form identities retain off-screen raw drafts, counts and recovery exports.
Returning to a page restores its draft. A cold reopen starts on the first page,
using the same complete saved state. Unsaved drafts still require explicit recovery
export before forced termination; pagination does not claim durable draft storage.

Acceptance covers 251 records across three pages in both list and table renderers,
row edit retention, exact save, cold reopen and automated accessibility checks in
Chromium, Firefox and WebKit. Encrypted acceptance injects a write failure and
proves paging performs zero writes, preserves the snapshot and upload queue, and
keeps the exact view after invalid cursor rejection. Native boundaries additionally
cover huge offsets, noncollection nodes, savepoint recovery and deletion clamping.
Sanitizer runtime fuzzing includes page requests and rejected-view invariants.

Targeted acceptance and final regression results are recorded in PROJECT_STATUS.md
and SESSION_ANCHOR.md. Production load and physical-device acceptance remain open.
