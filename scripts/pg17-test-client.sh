#!/bin/sh
set -eu
container=${1:?GitHub PostgreSQL fixture container ID required}
case "$container" in *[!a-f0-9]*|'') exit 1;; esac
[ "${#container}" -ge 12 ] && [ "${#container}" -le 64 ]
directory="$PWD/.local/pg17-test-client"
mkdir -p "$directory"
for tool in pg_dump pg_restore; do
  printf '%s\n' '#!/bin/sh' "exec docker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGPASSWORD -e PGUSER -e PGDATABASE -e PGOPTIONS -e PGSSLMODE -e PGCONNECT_TIMEOUT '$container' $tool \"\$@\"" > "$directory/$tool"
  chmod 700 "$directory/$tool"
done
printf '%s\n' "$directory" >> "$GITHUB_PATH"
