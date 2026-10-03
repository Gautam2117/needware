# Needware

**Software when you need it.**

Needware is being built as a local-first application platform. Models produce a typed application representation; a Rust/WebAssembly runtime validates and executes it through explicit capabilities. Generated executable code is excluded from the application model.

This repository is under active implementation. It is not a completed or production-ready product. See [project status](docs/PROJECT_STATUS.md) for evidence and remaining requirements.

## Development

Required: Rust 1.99.0 with rustfmt, Clippy and `wasm32-unknown-unknown`; Node 24.21.0 LTS; pnpm 11.5.3; Python 3. Docker is needed for service integration checks.

```sh
pnpm doctor
pnpm check
pnpm test
pnpm security
```

Commands retain complete local logs in ignored `.logs/` and return bounded diagnostics. Lockfiles pin resolved dependencies. No provider credentials or paid cloud account are needed for domain tests.

## Engineering boundaries

- Deny-by-default capability authorization bound to application and revision.
- Canonical domain types in Rust; mechanically generated browser contracts.
- Immutable, signed packages; state remains separate from definitions.
- Encrypted private cloud content with user-held recovery; no service escrow.
- Verification, deployment, real provider execution, and device acceptance are recorded separately.

AGPL-3.0-or-later. User application data remains user-owned.
