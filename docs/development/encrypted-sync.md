# Encrypted Automerge boundary

`Replica::new` accepts a validated application, explicit sync scope, client-owned
document/device keys and a verified owner-signed membership. State outside the
scope remains local. Only the trusted host uses this API; action consent/type
validation remains the transactional runtime's responsibility before `commit_state`.

`commit_state` stages scoped field differences in Automerge, signs their canonical
expanded change and validates the final derived projection. A rejected operation
leaves document heads, history and current state untouched. Derived fields never
become authored CRDT values. Local-only changes update state without a shared change.

`known` returns immutable change hashes. `export` uses causal order and emits
bounded encrypted batches missing from a peer's known set. `receive` authenticates
the complete frame and every original writer, deduplicates, rejects actor forks,
checks causal availability, stages a cloned document and validates the projection
before publishing it. Missing history produces `MissingDependencies`; the host
can retry with complete missing history after reconnection. Never acknowledge a
frame before its durable journal transaction commits.

`checkpoint` encrypts a complete signed history within the same frame limit.
A newly constructed independent replica restores through `receive`, rather than
trusting a raw Automerge binary. Owner-authorized compaction uses a separately
bounded encrypted checkpoint and chunked cloud manifests. Current limits: 2 MiB serialized frames, 512 KiB plaintext
batch, 256 KiB signed change, 4096 operations/change and changes/frame, 100,000
operations/16 MiB retained history, 128 predecessors/dependencies and bounded
typed runtime state. Limits reject oversized work atomically. They are ceilings,
not performance claims.

Document IDs derive deterministically from canonical account/application/instance
UUIDs, using a domain-separated BLAKE3 digest represented as a UUIDv8. Different
instances/accounts receive different identities. A random independent document
key is created separately; the identity never supplies encryption material.

Read grants receive state but cannot sign authorized writes. Hosts reject removed
writers and stale generations; full revocation requires authoritative relay
membership enforcement plus a fresh random document key for future ciphertext.
Revocation cannot erase previously downloaded copies. Re-key/compaction creates a
new epoch and must retain the prior encrypted history until atomic replacement;
old offline changes require an explicit review/rebase path still under construction.

Native tests cover three independent clients including a separate collaborator
account, offline concurrent fields, same-field winners, concurrent record creation,
delete-vs-edit, retries/missing history, ciphertext/signature/role attacks, hostile
authenticated changes, replay/dedup, snapshot reopen with a fresh actor, local-only
exclusion, derived recomputation, context/epoch mismatch and hostile-byte properties.
Encrypted browser journals, actual PostgreSQL/HTTP encrypted object/frame relay,
owner recovery and quota/outbox retention are implemented and locally tested.
The trusted worker's cloud imports require explicit signer/permission review;
read-only/absent device grants reject at both server and native runtime boundaries.
See [relay protocol](../decisions/0009-authorized-ciphertext-relay.md).
Owner-authorized compaction/fresh keys run through native/WASM, atomic encrypted
local journals and staged PostgreSQL activation, with retained signed archives
and cold recovery from lost activation acknowledgments.
See [epoch protocol](../decisions/0010-owner-authorized-document-epochs.md).
See [cloud activation](../decisions/0011-atomic-cloud-document-epochs.md). Public
deployment, exact physical devices, account-root rotation and complete selected
revocation/rebase remain unfinished.
