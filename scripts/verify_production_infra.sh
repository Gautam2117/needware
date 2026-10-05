#!/bin/sh
set -eu
docker run --rm \
  -v "$PWD/infra/production:/config:ro" \
  -v "$PWD/tests/production-ingress.py:/verify-ingress.py:ro" \
  debian:bookworm-slim sh -c '
    apt-get update -qq && apt-get install -y -qq systemd caddy python3 git >/dev/null &&
    mkdir -p /opt/needware/node/bin /opt/needware/current/apps/web/.next/cache /opt/needware/current/apps/web/.next/server/route-cache &&
    ln -s /bin/true /opt/needware/node/bin/node && useradd needware &&
    systemd-analyze verify /config/needware@.service &&
    NEEDWARE_PUBLIC_HOST=needware.continuumarc.tech caddy validate --config /config/Caddyfile --adapter caddyfile &&
    python3 /verify-ingress.py &&
    mkdir /tmp/release-fixture && git init -q /tmp/release-fixture &&
    chmod 755 /tmp/release-fixture &&
    if runuser -u needware -- git -C /tmp/release-fixture status --porcelain >/dev/null 2>&1; then exit 1; fi &&
    runuser -u needware -- git -C /tmp/release-fixture -c safe.directory=/tmp/release-fixture status --porcelain &&
    echo "PASS non-owner Git reads require trust scoped to the exact immutable release"
  '
