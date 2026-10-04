# Owner-authorized document epochs

Accepted 2026-10-04. Implemented native/WASM, local journals and staged atomic
PostgreSQL publication. Account-root rotation, schema revisions and selected
remaining-device revocation/rebase remain unfinished.

The owner creates an independently random document key. Document key epoch and
membership generation each advance exactly once. An Ed25519 owner attestation,
under the pinned account authority and a separate domain, binds both contexts,
generations, canonical previous/next bindings, original signed-history digest
and compacted baseline digest. Current checkpoint transitions retain the exact
application, revision, scope and schema epoch.

Compaction materializes only shared authored fields, excludes derived caches and
device-local values, and retains UUID delete-wins tombstones even when a
concurrent delete lost the ordinary Automerge value selection. Baseline changes
are signed by the authorized checkpoint writer. Original writers' signatures
remain in the old encrypted archive; checkpointing attributes the chosen
baseline to its owner without rewriting original historical authorship.

The encrypted checkpoint is at most 16 MiB. Changes retain existing signature,
operation, causal and history bounds. Installing a checkpoint verifies its owner
attestation, baseline digest and each signed change before projecting the whole
baseline once. Partial baseline batches must never expose incomplete records.
Read-only recipients can install the checkpoint without signing shared changes.
Old keys and old-generation frames cannot decrypt or join the new epoch.

A source peer verifies the signed cut against its exact history digest. A mismatch
means its offline work is outside the owner's cut and must be retained for
explicit review/rebase; it is not an upload acknowledgment. There is no automatic
cross-epoch replay.

The browser stages a new opaque WASM session and key, retains the complete old
journal, and publishes the encrypted journal under account/document CAS and
storage quotas before activating the new session/key. Failures retain the old
running state and key. Reopening verifies checkpoints and shared history in a
temporary vault before adopting a newer key; older keys cannot replace current
epochs. The journal retains up to four old epochs within existing 32 MiB document
and 128 MiB account limits. Reaching these limits preserves existing data and
rejects the operation; archive export/pruning UX is still pending.

Local compaction rejects cloud-enabled documents. They use the separately
approved [atomic cloud protocol](0011-atomic-cloud-document-epochs.md), including
a durable encrypted intent, charged staged chunks, source-cursor checks, retained
server ciphertext archives and fresh owner grants. Publishing an independently
compacted local document directly into the cloud remains explicitly disabled.
