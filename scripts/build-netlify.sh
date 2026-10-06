#!/bin/sh
set -eu
# Build all assets before Netlify adapts Next.js; do not use the web-only command.
test "$(node --version)" = "v24.21.0"
test "$(pnpm --version)" = "11.5.3"
command -v rustup >/dev/null
rustup toolchain install 1.99.0 --profile minimal --target wasm32-unknown-unknown
if [ "$(wasm-bindgen --version 2>/dev/null || true)" != "wasm-bindgen 0.2.129" ]; then
  cargo +1.99.0 install wasm-bindgen-cli --version 0.2.129 --locked
fi
cargo +1.99.0 build --release -p needware-control-plane
pnpm build
node scripts/verify_build_readiness.mjs
