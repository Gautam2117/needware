# Durable synchronized schema revisions

The owner reviews a signed successor against the exact signed parent package,
authenticated shared history and state. Native review binds the target package,
scope, runtime migration and source cut. Any local edit invalidates that review.
Destructive migrations need separate affirmative consent. Publication also
requires explicit signer, permissions and retained-device review.

The browser writes an encrypted immutable publication intent before uploading.
The server verifies the owner signature, consecutive schema epoch and fresh key
generation, current device authorization and exact source cursor. An ordinary
key rotation cannot activate a schema change. PostgreSQL atomically archives the
old encrypted objects and grants, activates the checkpoint and selected fresh
HPKE offers, and updates quota accounting. Failed activation leaves the old
revision usable. Lost acknowledgments resume the durable intent after restart.

An application revision identifies the signed application definition. A schema
epoch identifies the shared document's schema cut. Each accepted successor
increments the schema epoch and encryption generation; ordinary compaction only
increments the encryption generation. Account-root epochs are independent and
cannot be combined with a schema publication through this endpoint.

Stale clients authenticate the current binding before using their previous
cursor or uploading. A changed binding stops synchronization and editing with a
clear review state. The server rejects old-generation frames even from retained
collaborators. The client authenticates the target package, exact signed parent,
transition, checkpoint and fresh key before presenting adoption.

Adoption requires explicit preservation consent. One encrypted journal CAS
stores the new revision and an archive of the old package, state, history and
queued frames. Concurrent edits invalidate adoption. No old-schema frame is
replayed automatically. Recovery history offers deliberate plaintext state and
package export; these exports must be treated as private data. Up to four cuts
are retained; reaching that bound stops publication/adoption with the source
intact. Automatic compatible rebase and archive pruning are not implemented.

`pnpm test:revisions` uses independent real accounts, native signatures, browser
durability and disposable PostgreSQL. It covers destructive consent, injected
atomic activation failure, lost acknowledgment/cold resume, offline edits before
and after publication, stale-key rejection, explicit preservation, concurrent
review conflict, archive cold reopen and fresh-schema convergence. This is local
acceptance; deployed and exact-device acceptance remain separate.
