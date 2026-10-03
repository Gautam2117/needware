# Compatibility

Product releases use CalVer. IR schema and package container currently use independent technical version 1. Unknown IR/container versions or required runtime features fail explicitly.

WASM ABI and encrypted sync protocol acquire independent versions when their executable boundaries land. They are not inferred from product release numbers.

A package revision is immutable. State revision must match its application definition; adopting another revision requires validated migration. Rolling back a definition never implicitly deletes newer state.
