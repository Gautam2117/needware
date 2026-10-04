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
pnpm bootstrap
pnpm check
pnpm test
pnpm security
pnpm build
pnpm test:compiler
pnpm --filter @needware/web start --port 3108
NEEDWARE_TEST_URL=http://127.0.0.1:3108 pnpm test:e2e
```

Commands retain complete local logs in ignored `.logs/` and return bounded diagnostics. Lockfiles pin resolved dependencies. No provider credentials or paid cloud account are needed for domain tests.

Bootstrap starts digest-pinned PostgreSQL and a local mail inbox with preserved random secrets and persistent volumes. See [local dependency setup](docs/development/local-services.md); these services do not yet implement account features.

The browser can run the authored habit tracker or import signed `.need` packages after explicit signer/permission review. Rust/WASM executes mutations; SQLite/OPFS coordinates writers, with an explicit IndexedDB fallback. A production build caches its shell/runtime for offline reopen. Package and plaintext state exports are separate. The current host accepts local-storage applications and rejects unsupported renderer components before startup.

`pnpm dev` starts the shell and local Rust compiler gateway. Configure an approved provider using `.env.example`; without a provider, generation is unavailable. Creation requires disclosure of the recipient and installation-owned credentials. Four HTTP adapters feed a bounded Rust validation/signing pipeline. `pnpm test:compiler` explicitly starts a free HTTP fixture and verifies the browser wiring; it does not call a model. See [compiler setup and limitations](docs/development/compiler.md). Account services remain under implementation.

## Engineering boundaries

Native and browser revisions support explicit [preview, activation and recoverable rollback](docs/development/revisions.md). The browser retains the previous package and data atomically and rejects stale reviews. Compiler-driven refinement and synchronized schema transitions remain under implementation.

- Deny-by-default capability authorization bound to application and revision.
- Canonical domain types in Rust; mechanically generated browser contracts.
- Immutable, signed packages; state remains separate from definitions.
- Encrypted private cloud content with user-held recovery; no service escrow.
- Verification, deployment, real provider execution, and device acceptance are recorded separately.

AGPL-3.0-or-later. User application data remains user-owned.
