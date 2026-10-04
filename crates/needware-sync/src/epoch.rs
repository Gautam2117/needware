use super::*;
use needware_vault::{
    AccountVault, DocumentTransition, KeyContext, RootRotation, TransitionDigests,
};

const CHECKPOINT_METADATA: &[u8] = b"needware owner epoch checkpoint v1";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EpochCheckpoint {
    pub transition: DocumentTransition,
    entries: Vec<wire::SignedChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_rotation: Option<RootRotation>,
}
pub struct EpochTrust<'a> {
    pub previous: &'a Binding,
    pub root: &'a KeyContext,
    pub authority: &'a [u8; 32],
    pub roster: &'a [VerifiedMembership],
}
pub struct RootEpochTrust<'a> {
    pub epoch: EpochTrust<'a>,
    pub previous_root: &'a KeyContext,
    pub previous_authority: &'a [u8; 32],
}
/// Host must durably retain the old journal/archive and atomically publish the
/// new encrypted journal/key before exposing this staged replica.
pub struct PreparedEpoch {
    pub replica: Replica,
    pub checkpoint: Vec<u8>,
    pub transition: DocumentTransition,
    pub archive: Vec<EncryptedFrame>,
    pub root_rotation: Option<RootRotation>,
}
fn digest<T: Serialize>(value: &T) -> Result<[u8; 32]> {
    Ok(*blake3::hash(&wire::canonical(value)?).as_bytes())
}
impl EpochCheckpoint {
    fn seal(&self, key: &DocumentKey) -> Result<Vec<u8>> {
        let bytes = zeroize::Zeroizing::new(wire::canonical(self)?);
        if bytes.len() > MAX_LOG_BYTES {
            return Err(SyncError::Limit);
        }
        key.seal(&bytes, CHECKPOINT_METADATA)
            .map_err(|_| SyncError::Invalid)
    }
    fn open(key: &DocumentKey, ciphertext: &[u8]) -> Result<Self> {
        if ciphertext.len() > MAX_LOG_BYTES + 40 {
            return Err(SyncError::Limit);
        }
        let bytes = key
            .open(ciphertext, CHECKPOINT_METADATA)
            .map_err(|_| SyncError::Authorization)?;
        let checkpoint: Self = serde_json::from_slice(&bytes).map_err(|_| SyncError::Invalid)?;
        if wire::canonical(&checkpoint)? != *bytes {
            return Err(SyncError::Invalid);
        }
        if checkpoint.entries.len() > MAX_OPERATIONS {
            return Err(SyncError::Limit);
        }
        Ok(checkpoint)
    }
}
impl Replica {
    pub fn wrap_held_key(&self, holder: &AccountVault) -> Result<needware_vault::HeldDocumentKey> {
        holder
            .wrap_held_document(&self.key)
            .map_err(|_| SyncError::Authorization)
    }
    pub fn history_digest(&self) -> Result<[u8; 32]> {
        digest(&(&self.binding, self.log.values().collect::<Vec<_>>()))
    }
    /// A stale/offline peer cannot mistake this owner cut for acknowledgment of
    /// its unsent work. The host retains that old work for an explicit rebase.
    pub fn matches_epoch_cut(&self, transition: &DocumentTransition) -> Result<bool> {
        let root = KeyContext {
            version: 1,
            kind: needware_vault::KeyKind::AccountRoot,
            account: self.binding.document.account.clone(),
            document: None,
            epoch: self.root_epoch,
        };
        transition
            .verify(
                &self.binding.document,
                self.binding.generation,
                &root,
                &self.authority,
                &digest(&self.binding)?,
            )
            .map_err(|_| SyncError::Authorization)?;
        Ok(transition.previous == self.binding.document
            && transition.previous_generation == self.binding.generation
            && transition.digests.previous_binding == digest(&self.binding)?
            && transition.digests.history == self.history_digest()?)
    }
    pub fn matches_root_epoch_cut(
        &self,
        transition: &DocumentTransition,
        rotation: &RootRotation,
    ) -> Result<bool> {
        let previous = KeyContext {
            version: 1,
            kind: needware_vault::KeyKind::AccountRoot,
            account: self.binding.document.account.clone(),
            document: None,
            epoch: self.root_epoch,
        };
        let next = rotation
            .verify(&previous, &self.authority)
            .map_err(|_| SyncError::Authorization)?;
        transition
            .verify(
                &self.binding.document,
                self.binding.generation,
                next.context(),
                next.public(),
                &digest(&self.binding)?,
            )
            .map_err(|_| SyncError::Authorization)?;
        Ok(transition.digests.history == self.history_digest()?)
    }
    pub fn prepare_epoch(
        &mut self,
        owner: &AccountVault,
        next_key: DocumentKey,
        next_membership: &VerifiedMembership,
        consent: bool,
    ) -> Result<PreparedEpoch> {
        self.prepare_authorized_epoch(owner, next_key, next_membership, None, consent)
    }
    pub fn prepare_root_epoch(
        &mut self,
        owner: &AccountVault,
        rotation: &RootRotation,
        next_key: DocumentKey,
        next_membership: &VerifiedMembership,
        consent: bool,
    ) -> Result<PreparedEpoch> {
        self.prepare_authorized_epoch(owner, next_key, next_membership, Some(rotation), consent)
    }
    fn prepare_authorized_epoch(
        &mut self,
        owner: &AccountVault,
        next_key: DocumentKey,
        next_membership: &VerifiedMembership,
        rotation: Option<&RootRotation>,
        consent: bool,
    ) -> Result<PreparedEpoch> {
        let (authority, root_epoch) = if let Some(rotation) = rotation {
            let previous = KeyContext {
                version: 1,
                kind: needware_vault::KeyKind::AccountRoot,
                account: self.binding.document.account.clone(),
                document: None,
                epoch: self.root_epoch,
            };
            let verified = rotation
                .verify(&previous, &self.authority)
                .map_err(|_| SyncError::Authorization)?;
            if verified.context() != owner.context() {
                return Err(SyncError::Authorization);
            }
            (*verified.public(), verified.context().epoch)
        } else {
            (self.authority, self.root_epoch)
        };
        let public = self.device.public().map_err(|_| SyncError::Authorization)?;
        if !consent
            || !self.writable
            || owner.authority().map_err(|_| SyncError::Authorization)? != authority
            || owner.context().account != self.binding.document.account
            || owner.context().epoch != root_epoch
            || next_membership.authority() != &authority
            || next_membership.root_epoch() != root_epoch
            || next_membership.device() != &public
            || next_membership.role() != DocumentRole::Write
            || self.binding.generation.checked_add(1) != Some(next_membership.generation())
            || self.binding.document.epoch.checked_add(1) != Some(next_key.context().epoch)
            || self.binding.document.account != next_key.context().account
            || self.binding.document.document != next_key.context().document
        {
            return Err(SyncError::Authorization);
        }
        let mut next = Self::new(
            self.app.clone(),
            self.scope.clone(),
            next_key,
            self.device.fork_session(),
            next_membership,
            self.binding.schema_epoch,
        )?;
        let mut cells = mapping::flatten(&self.state, self.app.application(), &self.scope)?;
        // Retain delete-wins UUID tombstones across compaction, including losing
        // concurrent deletes. Hidden/deleted record contents are not copied.
        for key in self.doc.keys(ROOT) {
            let address = mapping::Address::parse(&key, self.app.application(), &self.scope)?;
            if !matches!(address, mapping::Address::Record { .. }) {
                continue;
            }
            for (value, _) in self
                .doc
                .get_all(ROOT, &key)
                .map_err(|_| SyncError::Invalid)?
            {
                let automerge::Value::Scalar(value) = value else {
                    return Err(SyncError::Invalid);
                };
                let ScalarValue::Str(text) = value.as_ref() else {
                    return Err(SyncError::Invalid);
                };
                if mapping::value(&address, text)? == Some(needware_ir::Value::Boolean(false)) {
                    cells.insert(
                        key.clone(),
                        String::from_utf8(wire::canonical(&Some(needware_ir::Value::Boolean(
                            false,
                        )))?)
                        .map_err(|_| SyncError::Invalid)?,
                    );
                    break;
                }
            }
        }
        if cells.len() > MAX_OPERATIONS {
            return Err(SyncError::Limit);
        }
        let mut batch_bytes = 0;
        let mut batch_operations = 0;
        for (key, value) in cells {
            let size = key.len() + value.len() + 512;
            if batch_operations > 0 && (batch_bytes + size > 64 * 1024 || batch_operations >= 256) {
                next.commit_baseline_batch()?;
                batch_bytes = 0;
                batch_operations = 0;
            }
            next.doc
                .put(ROOT, key, value)
                .map_err(|_| SyncError::Invalid)?;
            batch_bytes += size;
            batch_operations += 1;
        }
        if batch_operations > 0 {
            next.commit_baseline_batch()?;
        }
        Self::check_log(&next.log)?;
        next.state = mapping::project(&next.doc, &self.state, next.app.application(), &next.scope)?;
        if next.state != self.state {
            return Err(SyncError::Invalid);
        }
        let entries = next
            .doc
            .get_changes(&[])
            .iter()
            .map(|change| {
                next.log
                    .get(&change.hash())
                    .cloned()
                    .ok_or(SyncError::Invalid)
            })
            .collect::<Result<Vec<_>>>()?;
        let transition = owner
            .document_transition(
                &self.key,
                &next.key,
                self.binding.generation,
                TransitionDigests {
                    previous_binding: digest(&self.binding)?,
                    next_binding: digest(&next.binding)?,
                    history: self.history_digest()?,
                    baseline: digest(&entries)?,
                },
            )
            .map_err(|_| SyncError::Authorization)?;
        let checkpoint = EpochCheckpoint {
            transition: transition.clone(),
            entries,
            root_rotation: rotation.cloned(),
        }
        .seal(&next.key)?;
        let archive = self.export(&BTreeSet::new())?;
        Ok(PreparedEpoch {
            replica: next,
            checkpoint,
            transition,
            archive,
            root_rotation: rotation.cloned(),
        })
    }
    fn commit_baseline_batch(&mut self) -> Result<()> {
        self.doc.commit();
        let change = self.doc.get_last_local_change().ok_or(SyncError::Invalid)?;
        let signed = wire::SignedChange::create(&self.binding, &self.device, &change)?;
        self.log.insert(change.hash(), signed);
        Self::check_log(&self.log)
    }
    /// Install a verified owner checkpoint only into a fresh staged session.
    /// Old sessions/keys/history remain untouched on failure.
    pub fn install_epoch(
        &mut self,
        ciphertext: &[u8],
        trust: EpochTrust<'_>,
    ) -> Result<DocumentTransition> {
        let checkpoint = EpochCheckpoint::open(&self.key, ciphertext)?;
        if checkpoint.root_rotation.is_some() {
            return Err(SyncError::Authorization);
        }
        self.install_verified_checkpoint(checkpoint, trust)
    }
    pub fn install_root_epoch(
        &mut self,
        ciphertext: &[u8],
        trust: RootEpochTrust<'_>,
    ) -> Result<DocumentTransition> {
        let checkpoint = EpochCheckpoint::open(&self.key, ciphertext)?;
        let rotation = checkpoint
            .root_rotation
            .as_ref()
            .ok_or(SyncError::Authorization)?;
        let verified = rotation
            .verify(trust.previous_root, trust.previous_authority)
            .map_err(|_| SyncError::Authorization)?;
        if verified.context() != trust.epoch.root || verified.public() != trust.epoch.authority {
            return Err(SyncError::Authorization);
        }
        self.install_verified_checkpoint(checkpoint, trust.epoch)
    }
    /// A recovered client anchors the historical pin at its independently trusted current root.
    pub fn install_accepted_root_epoch(
        &mut self,
        ciphertext: &[u8],
        trust: EpochTrust<'_>,
    ) -> Result<DocumentTransition> {
        let checkpoint = EpochCheckpoint::open(&self.key, ciphertext)?;
        let rotation = checkpoint
            .root_rotation
            .as_ref()
            .ok_or(SyncError::Authorization)?;
        rotation
            .verify_current(trust.root, trust.authority)
            .map_err(|_| SyncError::Authorization)?;
        self.install_verified_checkpoint(checkpoint, trust)
    }
    fn install_verified_checkpoint(
        &mut self,
        checkpoint: EpochCheckpoint,
        trust: EpochTrust<'_>,
    ) -> Result<DocumentTransition> {
        if !self.log.is_empty() || !self.doc.get_changes(&[]).is_empty() {
            return Err(SyncError::Protocol);
        }
        let transition = &checkpoint.transition;
        transition
            .verify(
                &trust.previous.document,
                trust.previous.generation,
                trust.root,
                trust.authority,
                &digest(trust.previous)?,
            )
            .map_err(|_| SyncError::Authorization)?;
        if transition.next != self.binding.document
            || transition.next_generation != self.binding.generation
            || transition.digests.next_binding != digest(&self.binding)?
            || transition.digests.baseline != digest(&checkpoint.entries)?
            || transition.authority != self.authority
            || transition.root.epoch != self.root_epoch
            || trust.previous.application != self.binding.application
            || trust.previous.revision != self.binding.revision
            || trust.previous.schema_epoch != self.binding.schema_epoch
            || trust.previous.schema_digest != self.binding.schema_digest
        {
            return Err(SyncError::Protocol);
        }
        // The baseline remains signed by the original checkpoint writer, even
        // when installed by a read-only collaborator. Never re-sign as receiver.
        let mut candidate = self.fork_session()?;
        candidate.receive_entries(checkpoint.entries, trust.roster)?;
        self.doc = candidate.doc;
        self.state = candidate.state;
        self.log = candidate.log;
        Ok(checkpoint.transition)
    }
}
