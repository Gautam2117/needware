# Reviewed revisions and recoverable activation

A target revision must retain application identity and name the active package digest as its parent. Migration declarations are bounded and reject ambient/event input. Operations explicitly account for data-schema changes. A transform is conservatively destructive because reversibility cannot be inferred from an arbitrary expression.

The migration engine evaluates a copy of the source state. Each transform reads a stable pre-operation snapshot, so record ordering cannot change its result. All operations share work limits; output growth is checked against the state ceiling. Runtime validation checks the entire candidate against the target schema before creating a review object.

Review identity binds the source package, target package and exact source state. Approval rejects a stale source or mismatched review digest. Broader declared permissions are reported separately. Native CLI approval does not grant browser capabilities.

SQLite commits the pre-transition state snapshot and new state in one transaction guarded by generation and exact previous state. Ordinary state commits cannot cross revisions. An injected failure after snapshot insertion rolls back both writes. Rollback also snapshots the current state, preserving edits made after activation. History has a 128 MiB application limit and is never silently evicted. Deleting local application data cascades to its local history.

The browser uses the same Rust review proof through WASM. The trusted shell reviews signer identity, affected records, destructive changes and broader permissions. Activation retains both the old signed package and state in one SQLite/OPFS or IndexedDB transaction. Exact prior generation, digest and state must still match; a concurrent tab invalidates approval. The renderer is checked before persistence and receives a fresh instance after activation. Recovery history can restore an earlier package and state while saving the current copy first. Package bytes count toward the 128 MiB browser history ceiling. Deletion removes the application's history atomically.

Three-engine browser tests exercise destructive consent, target defaults, stale reviews, wrong parents, offline reopen with the actual server stopped, rollback and recovery of the rolled-back revision. Browser quota/fault injection, persistent signer-trust records and synchronized schema epochs remain separate gates. Native callers must retain the previous signed package alongside their state backups.
