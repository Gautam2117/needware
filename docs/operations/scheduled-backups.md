# Unattended encrypted recovery

The prepared runner exports a PostgreSQL repeatable-read snapshot, encrypts the dump with AES-256-GCM, restores it into a disposable local PostgreSQL17 database, and verifies matching schema and every auth_/needware_ row against that exact snapshot. Customer activity continues during the backup. No plaintext dump is uploaded.

Proposed destination: private repository `Gautam2117/needware-operations`, protected environment `production-backup`. The workflow runs daily at02:17UTC, retains encrypted backups for7days, and refuses artifacts larger than16MiB. Existing GitHub Actions/storage allowance and a zero spending limit must be verified before activation. The source is a fixed verified Needware commit; third-party actions and the PostgreSQL image are pinned. Package installation runs before credentials are provided to the backup step.

The environment needs only a dedicated database reader credential, the database public CA and a separate backup encryption key. The reader can read Needware's public-schema application/authentication tables and sequences; it cannot modify data or schemas. It receives narrowly scoped SELECT/RLS access rather than the application database owner's credential. The recovery key also remains in a private local recovery file. Secrets are not stored in Git, logs, artifacts or the public Needware repository.

Artifacts contain encrypted account/application/payment records. The receipt contains only verification status, byte count, timestamp and data digest. Existing local backup files and keys remain untouched. Failure preserves the encrypted file locally but prevents uploading it as a passing backup.

Activation steps: approve this destination/access; create and verify the reader role and private repository; verify free billing headroom/spend limit; install environment secrets and the fixed source SHA; run the real cloud job; verify the artifact and GitHub failure notification; verify the daily schedule. A local successful backup/restore alone is not proof of an active unattended schedule.

Implementation: `scripts/scheduled-backup.mjs`, `scripts/pg17-backup-client.sh`; prepared workflow `.local/operations-workflow-template.yml`. Restoring a retained artifact uses `scripts/backup.mjs restore` with the separately retained key and a new empty target database/schema. Restore acceptance must pass before relying on the schedule.
