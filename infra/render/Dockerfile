FROM rust:1.99.0-bookworm AS rust-tools
FROM node:24.21.0-bookworm-slim AS build
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH CARGO_BUILD_JOBS=2 NEXT_TELEMETRY_DISABLED=1
COPY --from=rust-tools /usr/local/cargo /usr/local/cargo
COPY --from=rust-tools /usr/local/rustup /usr/local/rustup
RUN apt-get update -qq && apt-get install -y --no-install-recommends git ca-certificates build-essential pkg-config libssl-dev python3 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.5.3 && rustup target add wasm32-unknown-unknown && cargo install wasm-bindgen-cli --version 0.2.129 --locked
ARG RENDER_GIT_COMMIT
WORKDIR /app
# Build only the exact public Git release. No local files or secret build arguments enter this image.
RUN test -n "$RENDER_GIT_COMMIT" && git init -q && git remote add origin https://github.com/Gautam2117/needware.git && git fetch --depth=1 origin "$RENDER_GIT_COMMIT" && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = "$RENDER_GIT_COMMIT"
RUN pnpm install --frozen-lockfile && cargo build --release -p needware-control-plane && pnpm build && node scripts/build-readiness.mjs && test -z "$(git status --porcelain --untracked-files=normal)"
RUN find target/release -mindepth 1 -maxdepth 1 ! -name needware-control-plane -exec rm -rf '{}' + && rm -rf target/debug target/wasm32-unknown-unknown apps/web/.next/cache
FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 XDG_DATA_HOME=/tmp/caddy/data XDG_CONFIG_HOME=/tmp/caddy/config
RUN apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates git caddy && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home needware
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p apps/web/.next/cache apps/web/.next/server/route-cache && chown -R needware:needware apps/web/.next/cache apps/web/.next/server/route-cache
USER needware
EXPOSE 10000
CMD ["node","scripts/render-service.mjs"]
