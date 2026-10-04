# ADR 0006: authenticated Automerge projection

Accepted 2026-10-04. `needware-sync` uses Automerge 0.12.0, shared by native and
WASM, with an explicit allowlist of synchronized state keys and collections.
Each scalar state key and each non-derived record field is an independent root
map entry. Lists/maps inside a field currently replace atomically. Record UUIDs
are stable identities; tombstones win against concurrent edits/creates and a
deleted UUID cannot be resurrected. Creating another record requires a new UUID.
Automerge resolves concurrent scalar values deterministically. Derived fields
are excluded from change history and recomputed/validated after each merge.

Wire protocol v1 encrypts canonical, bounded JSON expansions of native changes.
It deliberately accepts no compressed binary Automerge input, preventing an
untrusted DEFLATE/RLE stream from allocating before our application-level limits.
Only root-map scalar assignments are supported. Changes retain their original
device signature when forwarded or checkpointed. Owner-signed document grants
bind device keys, read/write role, document/key epoch and membership generation.
Hosts pin owner authority and current generation before constructing a roster.
Possession of a shared document key alone cannot authorize writes.

Protocol, document identity, application/revision, schema epoch, schema+scope
digest and membership generation are authenticated both in change signatures and
encryption metadata. Incompatible clients fail explicitly; schema migrations do
not silently merge. A fresh actor suffix per writer/reopen prevents stale local
copies from reusing a device's Automerge sequence. Actor forks, skipped histories,
unsupported operations and invalid cells fail before committing staged state.

Complete host integration remains open: atomic encrypted durable journals,
multi-tab writers, account identity/pinning UX, relay/backoff, synchronized review
and migration, browser recovery, large-history checkpoint chunks and compaction.
The library's in-memory/offline tests and WASM compilation establish that boundary
only; they do not prove cloud collaboration, physical devices or production.
