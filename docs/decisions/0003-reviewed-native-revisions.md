# Reviewed revisions and recoverable activation

A target revision must retain application identity and name the active package digest as its parent. Migration declarations are bounded and reject ambient/event input. Operations explicitly account for data-schema changes. A transform is conservatively destructive because reversibility cannot be inferred from an arbitrary expression.

The migration engine evaluates a copy of the source state. Each transform reads a stable pre-operation snapshot, so record ordering cannot change its result. All operations share work limits; output growth is checked against the state ceiling. Runtime validation checks the entire candidate against the target schema before creating a review object.

Review identity binds the source package, target package and exact source state. Approval rejects a stale source or mismatched review digest. Broader declared permissions are reported separately. Native CLI approval does not grant browser capabilities.

SQLite commits the pre-transition state snapshot and new state in one transaction guarded by generation and exact previous state. Ordinary state commits cannot cross revisions. An injected failure after snapshot insertion rolls back both writes. Rollback also snapshots the current state, preserving edits made after activation. History has a 128 MiB application limit and is never silently evicted. Deleting local application data cascades to its local history.

This milestone exposes native commands. Browser revision review/activation, package-history retention and synchronized schema-epoch transitions still require separate wiring and evidence. The caller must retain the old signed package to execute a recovered snapshot.
