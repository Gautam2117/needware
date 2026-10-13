#!/bin/sh
set -eu
directory="$PWD/.local/pg17-backup-client"
mkdir -p "$directory"
for tool in pg_dump pg_restore; do
 cat > "$directory/$tool" <<EOF
#!/bin/sh
set -eu
if [ -n "\${PGSSLROOTCERT:-}" ]; then
 exec docker run --rm --network=host -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGOPTIONS -e PGSSLMODE -e PGCONNECT_TIMEOUT -e PGSSLROOTCERT=/tls/ca.pem -v "\$PGSSLROOTCERT:/tls/ca.pem:ro" postgres:17@sha256:ae69c452f483507a6b99fb654cf93aad7fe156ffd2c56247707eef4e36d3c12b $tool "\$@"
else
 exec docker run --rm --network=host -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGOPTIONS -e PGSSLMODE -e PGCONNECT_TIMEOUT postgres:17@sha256:ae69c452f483507a6b99fb654cf93aad7fe156ffd2c56247707eef4e36d3c12b $tool "\$@"
fi
EOF
 chmod 700 "$directory/$tool"
done
printf '%s\n' "$directory" >> "${GITHUB_PATH:?GitHub runner path required}"
