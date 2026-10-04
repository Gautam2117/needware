# Local dependency bootstrap

`pnpm bootstrap` validates pinned Rust/Node/pnpm/WASM tools, installs the frozen workspace dependencies and starts the `needware-dev` Compose project. It uses `docker-compose` when present, otherwise `docker compose`. PostgreSQL 18.6 and Mailpit v1.29.0 are pinned by multi-platform image digest. No cloud account or inference provider is required.

The ignored `.local/dev.env` file holds random local database, control-plane and authentication secrets with mode 600. Bootstrap preserves an existing file, `.env` and all database volumes. It does not reset passwords or remove volumes. `pnpm dev` reads explicit process configuration first, then nonempty `.env` entries, then local bootstrap defaults. Authentication secrets are development configuration, not an implemented account vault or recovery mechanism.

Only loopback ports are published: PostgreSQL 55432, SMTP 51025 and the [mail test inbox](http://127.0.0.1:58025) on 58025. The inbox captures local fixture mail; it does not send it to real recipients. PostgreSQL data mounts at `/var/lib/postgresql`, matching the [PostgreSQL 18 image layout](https://github.com/docker-library/docs/blob/master/postgres/content.md). Mailpit uses a persistent local database and its [built-in readiness check](https://mailpit.axllent.org/docs/integration/healthcheck/).

`python3 scripts/token_guard.py run 'python3 scripts/verify_local_services.py'` repeats bootstrap, checks that secrets are unchanged, authenticates with PostgreSQL's maintained client, writes a uniquely identified probe and sends a fixture to `example.invalid`. It restarts only these Needware containers and checks retained database/mail data. Run this while development requests are idle. The probe row is removed afterward. This verifies dependencies; account flows, PostgreSQL product migrations and real email delivery remain separate gates.

To stop these dependencies without deleting their data:

```sh
docker-compose --project-name needware-dev --env-file .local/dev.env -f infra/compose.dev.yaml stop
```

Use `docker compose` instead where the plugin is installed. A port conflict or unhealthy service causes bootstrap to fail without deleting existing data. Startup is local development infrastructure, not a production deployment or backup/restore drill.
