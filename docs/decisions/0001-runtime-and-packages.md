# Typed execution and signed immutable packages

Accepted: Rust owns the application language, evaluator, semantic validation, capability decisions and package verification. TypeScript represents generated contracts and trusted platform UI. Models supply typed IR rather than executable code.

The container is uncompressed and has no filesystem paths. JCS canonicalization plus BLAKE3 gives stable content identity; Ed25519 establishes signed integrity. The footer is excluded from content identity to permit multiple attestations without changing application identity.

Signer trust is reviewed independently from integrity. Local/test keys are not production trust roots. Native and WASM share the same core implementations.
