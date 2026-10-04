# Atomic encrypted cloud document epochs

Accepted 2026-10-04. Adversarial local PostgreSQL and Chromium/Firefox/WebKit
acceptance passes. Public deployment and complete account-device revocation remain
separate gates.

The existing owner pin verifies the native Ed25519 transition and BLAKE3 binding
digests independently in Node. The transition advances document key epoch and
membership generation exactly once, while preserving application/revision/schema.
The relay cannot verify plaintext history or checkpoint semantics; Rust verifies
the signed baseline after decryption. The source cursor pins the cloud cut, and
activation rejects any later old-generation upload.

Staged package/checkpoint chunks and canonical metadata count against the same
128 MiB owner quota as current and archived objects. Immutable manifests and
chunks make retries idempotent. Up to four retained prior generations are allowed.
Cancellation refunds only staged bytes. Quota failures preserve current objects.

Activation holds the document lock in one PostgreSQL transaction. It verifies
ordered ciphertext chunks, SHA-256 digests and byte counts; archives the previous
package, exact original frames and grants; removes current grants; installs the
fresh owner grant; switches the descriptor/binding; and resets the current frame
cursor. A database failure rolls everything back. Member-deletion refunds are
restored exactly because archived grants remain retained and charged. Active
bytes derive from the total document ledger minus staged/archived ledgers, so
later ordinary writes and independent device cascades remain correctly charged.

The browser first saves an encrypted pending intent containing the new held key,
checkpoint, encrypted package, target journal and source cursor. Writes pause
while the intent is pending. Network retries read staging status and resume missing
chunks. After activation, the browser verifies the target package/checkpoint and
atomically adopts the new journal before activating its opaque native key. Lost
acknowledgments or local commit failure retain enough information for cold recovery.
An active epoch cannot be cancelled. A changed source cut requires cancellation,
pulling old-generation history and explicit approval of another cut.

Cloud import uses a temporary vault and requires signer/permission review before
durable publication. Checkpoints install before new-generation frames. Archives
contain the old server ciphertext objects, rather than browser journals that can
contain device-local values. Archive download currently requires the owner pin.

Rotation removes existing collaborator grants; new invitations explicitly regrant
access. Old collaborators retain their downloaded data and queued offline edits.
Their old keys cannot decrypt the new package/checkpoint/updates. Other registered
owner devices can obtain new owner grants through root-held key recovery. This
does not revoke an owner device that already holds the account root. Such device
revocation requires account-root rotation and selected remaining-device enrollment.
Schema/revision rebase, selected-recipient rewrapping, root rotation, archive export
and pruning are subsequent protocol boundaries.
