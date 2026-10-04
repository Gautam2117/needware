# Deterministic derived record fields

Accepted implementation: the `derived_fields_v1` runtime feature enables computed
fields on top-level collection records. A derived field has an expression and a
declared type; it cannot have a default or be an action assignment target.
Dependencies on other derived fields must form an acyclic graph. Evaluation
follows dependency order rather than alphabetical field order.

Derived expressions can read their record and explicit state values, including
bounded operations on lists/maps held in those values. Event inputs, ambient
clock/locale/timezone context, and collection-wide reads are rejected. These
restrictions prevent cached values from changing due to time, an arbitrary last
event, record traversal order or an implicit cross-record dependency cycle.
Nested record types do not declare derived fields.

After each local mutation, the runtime recomputes projections before the next
action can read them. All recomputation shares the event's expression fuel and
32 MiB materialization allowance; record copies are charged before allocation.
Projection writes require the affected collection storage scopes. A permission,
evaluation or resource failure discards the entire candidate event, including
earlier base mutations and prepared effects.

Durable state contains the computed values. Validation recomputes and compares
them using a separate bounded verification budget. A missing, stale or tampered
projection rejects state restore/load. This verification does not change input
state. Explicit revisions account for changed field definitions through normal
declarative migrations; preview recomputes the target projections before review.
Source snapshots remain recoverable under their original signed definition.

This feature supplies deterministic local projections. Cross-client schema
epochs and CRDT projection rules remain part of the encrypted synchronization
implementation; this ADR does not claim those protocols exist.
