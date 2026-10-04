# Compatibility

Product releases use CalVer. IR schema and package container currently use independent technical version 1. Unknown IR/container versions or required runtime features fail explicitly.

`typed_contracts_v1` requires explicit state and per-action input contracts. Empty
contract maps remain omitted from legacy package serialization. This feature
requires the corresponding Rust/WASM runtime; older runtimes reject the feature.

WASM ABI and encrypted sync protocol acquire independent versions when their executable boundaries land. They are not inferred from product release numbers.

A package revision is immutable. State revision must match its application definition; adopting another revision requires validated migration. Rolling back a definition never implicitly deletes newer state.
