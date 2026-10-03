# Needware

**Software when you need it.**

Needware is being built as a local-first application platform. Models produce a typed application representation; a Rust/WebAssembly runtime validates and executes it through explicit capabilities. Generated executable code is excluded from the application model.

This repository is under active implementation. It is not a completed or production-ready product. See [project status](docs/PROJECT_STATUS.md) for evidence and remaining requirements.

## Development

Required: Rust 1.99.0 with rustfmt, Clippy and `wasm32-unknown-unknown`; Node 24.21.0 LTS; pnpm 11.5.3; Python 3. Docker is needed for service integration checks.

```sh
pnpm install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
pnpm doctor
pnpm check
pnpm test
pnpm security
pnpm build
pnpm --filter @needware/web start --port 3108
NEEDWARE_TEST_URL=http://127.0.0.1:3108 pnpm test:e2e
```

Commands retain complete local logs in ignored `.logs/` and return bounded diagnostics. Lockfiles pin resolved dependencies. No provider credentials or paid cloud account are needed for domain tests.

The browser can run the authored habit tracker or import signed `.need` packages after explicit signer/permission review. Rust/WASM executes mutations; SQLite/OPFS coordinates writers, with an explicit IndexedDB fallback. A production build caches its shell/runtime for offline reopen. Package and plaintext state exports are separate. The current host accepts local-storage applications and rejects unsupported renderer components before startup. Model generation and account services remain under implementation.

## Engineering boundaries

- Deny-by-default capability authorization bound to application and revision.
- Canonical domain types in Rust; mechanically generated browser contracts.
- Immutable, signed packages; state remains separate from definitions.
- Encrypted private cloud content with user-held recovery; no service escrow.
- Verification, deployment, real provider execution, and device acceptance are recorded separately.

AGPL-3.0-or-later. User application data remains user-owned.
