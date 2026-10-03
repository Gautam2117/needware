# Native revision review and recovery

Build the CLI with `cargo build -p needware-cli`. Use `target/debug/needware inspect FILE.need` to inspect signer identities. Trust only keys whose fingerprints you have reviewed; the commands below require explicit comma-separated Ed25519 public keys in hexadecimal.

```sh
needware state-init old.need local.sqlite --trust SIGNER_HEX
needware revision-preview old.need new.need local.sqlite --trust SIGNER_HEX
needware revision-apply old.need new.need local.sqlite --trust SIGNER_HEX --review REVIEW_DIGEST
```

Preview prints the affected collection/field, record counts, destructive status, added/removed permissions and a review digest. It leaves application state unchanged. Apply recomputes the preview against current state and rejects an outdated digest. Add `--accept-destructive` for removals/transforms and `--accept-permissions` for broader declared scopes only after reviewing their consequences.

The successful apply command identifies the retained snapshot generation. Retain the previous signed package alongside state backups. To restore snapshot 1 while the current database generation is 2:

```sh
needware revision-rollback new.need old.need local.sqlite --trust SIGNER_HEX --snapshot 1 --expected-generation 2 --accept-rollback
```

Rollback verifies the previous package, validates the snapshot against it, checks the current generation and saves the current state before restoration. It does not delete later edits from history. These commands operate on native SQLite state; browser revision activation remains pending.
