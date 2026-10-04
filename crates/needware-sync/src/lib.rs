//! Authenticated encrypted Automerge state projection; transport/storage are host boundaries.
mod epoch;
mod mapping;
pub use epoch::{EpochCheckpoint, EpochTrust, PreparedEpoch, RootEpochTrust};
#[cfg(test)]
mod tests;
mod wire;
pub use automerge::ChangeHash;
use automerge::transaction::Transactable;
use automerge::{ActorId, AutoCommit, Change, ROOT, ReadDoc, ScalarValue};
use needware_ir::State;
use needware_validation::ValidatedApplication;
use needware_vault::{DeviceKeys, DocumentKey, DocumentRole, VerifiedMembership};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;
pub use wire::EncryptedFrame;

pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES: usize = MAX_FRAME_BYTES / 4;
const MAX_LOG_BYTES: usize = 16 * 1024 * 1024;
const MAX_OPERATIONS: usize = 100_000;
#[derive(Debug, Error)]
pub enum SyncError {
    #[error("sync protocol, scope or schema epoch mismatch")]
    Protocol,
    #[error("sync authorization failed")]
    Authorization,
    #[error("sync resource limit exceeded")]
    Limit,
    #[error("sync change is invalid")]
    Invalid,
    #[error("sync dependencies are missing; retry with missing history")]
    MissingDependencies,
}
type Result<T> = std::result::Result<T, SyncError>;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub values: BTreeSet<String>,
    pub collections: BTreeSet<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub protocol: u16,
    pub document: needware_vault::KeyContext,
    pub application: String,
    pub revision: String,
    pub schema_epoch: u32,
    pub schema_digest: String,
    pub generation: u32,
}
pub struct Replica {
    app: ValidatedApplication,
    scope: Scope,
    binding: Binding,
    key: DocumentKey,
    device: DeviceKeys,
    writable: bool,
    authority: [u8; 32],
    root_epoch: u32,
    doc: AutoCommit,
    state: State,
    log: BTreeMap<ChangeHash, wire::SignedChange>,
}
impl Replica {
    /// Host stages a whole journal transaction before publishing this session.
    pub fn fork_session(&self) -> Result<Self> {
        let mut doc = self.doc.clone();
        let mut actor = self
            .device
            .public()
            .map_err(|_| SyncError::Authorization)?
            .signing
            .to_vec();
        let mut suffix = [0; 16];
        getrandom::fill(&mut suffix).map_err(|_| SyncError::Invalid)?;
        actor.extend(suffix);
        doc.set_actor(ActorId::from(actor));
        Ok(Self {
            app: self.app.clone(),
            scope: self.scope.clone(),
            binding: self.binding.clone(),
            key: self.key.fork_session(),
            device: self.device.fork_session(),
            writable: self.writable,
            authority: self.authority,
            root_epoch: self.root_epoch,
            doc,
            state: self.state.clone(),
            log: self.log.clone(),
        })
    }
    pub fn seal_payload(&self, bytes: &[u8], metadata: &[u8]) -> Result<Vec<u8>> {
        self.key
            .seal(bytes, metadata)
            .map_err(|_| SyncError::Invalid)
    }
    pub fn open_payload(
        &self,
        bytes: &[u8],
        metadata: &[u8],
    ) -> Result<zeroize::Zeroizing<Vec<u8>>> {
        self.key
            .open(bytes, metadata)
            .map_err(|_| SyncError::Invalid)
    }
    pub fn new(
        app: ValidatedApplication,
        scope: Scope,
        key: DocumentKey,
        device: DeviceKeys,
        membership: &VerifiedMembership,
        schema_epoch: u32,
    ) -> Result<Self> {
        scope.validate(app.application())?;
        let public = device.public().map_err(|_| SyncError::Authorization)?;
        if membership.device() != &public
            || membership.document() != key.context()
            || schema_epoch == 0
        {
            return Err(SyncError::Authorization);
        }
        let binding = Binding {
            protocol: 1,
            document: key.context().clone(),
            application: app.application().id.clone(),
            revision: app.application().revision.clone(),
            schema_epoch,
            schema_digest: hex::encode(
                blake3::hash(&wire::canonical(&(app.application(), &scope))?).as_bytes(),
            ),
            generation: membership.generation(),
        };
        // Each writer/reopen receives a fresh actor suffix to avoid concurrent sequence reuse.
        let mut actor = public.signing.to_vec();
        let mut session = [0; 16];
        getrandom::fill(&mut session).map_err(|_| SyncError::Invalid)?;
        actor.extend(session);
        let mut doc = AutoCommit::new();
        doc.set_actor(ActorId::from(actor));
        let mut state = State {
            revision: app.application().revision.clone(),
            values: app.application().state.clone(),
            collections: app
                .application()
                .collections
                .keys()
                .map(|name| (name.clone(), BTreeMap::new()))
                .collect(),
        };
        needware_validation::derived::materialize(
            app.application(),
            &mut state,
            &mut needware_expr::Budget::new(100_000),
        )
        .map_err(|_| SyncError::Invalid)?;
        needware_validation::validate_state(&state, app.application())
            .map_err(|_| SyncError::Invalid)?;
        Ok(Self {
            app,
            scope,
            binding,
            key,
            device,
            writable: membership.role() == DocumentRole::Write,
            authority: *membership.authority(),
            root_epoch: membership.root_epoch(),
            doc,
            state,
            log: BTreeMap::new(),
        })
    }
    pub fn state(&self) -> &State {
        &self.state
    }
    /// Restores device-local state only after authenticated shared history is replayed.
    pub fn restore_local_state(&mut self, next: State) -> Result<()> {
        needware_validation::validate_state(&next, self.app.application())
            .map_err(|_| SyncError::Invalid)?;
        let projected = mapping::project(&self.doc, &next, self.app.application(), &self.scope)?;
        if projected != next {
            return Err(SyncError::Invalid);
        }
        self.state = next;
        Ok(())
    }
    pub fn binding(&self) -> &Binding {
        &self.binding
    }
    pub fn heads(&mut self) -> Vec<ChangeHash> {
        self.doc.get_heads()
    }
    /// The runtime must validate and authorize actions before supplying their next state.
    pub fn commit_state(&mut self, next: State) -> Result<()> {
        needware_validation::validate_state(&next, self.app.application())
            .map_err(|_| SyncError::Invalid)?;
        let before = mapping::flatten(&self.state, self.app.application(), &self.scope)?;
        let after = mapping::flatten(&next, self.app.application(), &self.scope)?;
        let mut changed = BTreeMap::new();
        for (key, value) in &after {
            if before.get(key) != Some(value) {
                changed.insert(key.clone(), value.clone());
            }
        }
        for key in before.keys().filter(|key| !after.contains_key(*key)) {
            if mapping::is_deleted_record_field(key, &after)? {
                continue;
            }
            let value = mapping::removed(key)?;
            changed.insert(key.clone(), value);
        }
        if changed.is_empty() {
            self.state = next;
            return Ok(());
        }
        if !self.writable {
            return Err(SyncError::Authorization);
        }
        if changed.len() > 4096 {
            return Err(SyncError::Limit);
        }
        let mut candidate = self.doc.clone();
        for (key, value) in changed {
            // A deleted UUID cannot be resurrected; creating a new record requires a new UUID.
            mapping::prevent_resurrection(&candidate, &key, &value)?;
            candidate
                .put(ROOT, key, value)
                .map_err(|_| SyncError::Invalid)?;
        }
        candidate.commit();
        let change = candidate
            .get_last_local_change()
            .ok_or(SyncError::Invalid)?;
        let signed = wire::SignedChange::create(&self.binding, &self.device, &change)?;
        let mut log = self.log.clone();
        log.insert(change.hash(), signed);
        Self::check_log(&log)?;
        let projected = mapping::project(&candidate, &next, self.app.application(), &self.scope)?;
        self.doc = candidate;
        self.state = projected;
        self.log = log;
        Ok(())
    }
    fn check_log(log: &BTreeMap<ChangeHash, wire::SignedChange>) -> Result<()> {
        let bytes = log
            .values()
            .map(|entry| entry.change.len() + 256)
            .sum::<usize>();
        let ops = log.values().map(|entry| entry.operations).sum::<usize>();
        if bytes > MAX_LOG_BYTES || ops > MAX_OPERATIONS {
            return Err(SyncError::Limit);
        }
        Ok(())
    }
    /// A bounded batch of immutable signed changes. Empty peers can request all hashes.
    pub fn export(&mut self, known: &BTreeSet<ChangeHash>) -> Result<Vec<EncryptedFrame>> {
        let mut frames = Vec::new();
        let mut batch = Vec::new();
        let mut bytes = 0;
        for change in self.doc.get_changes(&[]) {
            if known.contains(&change.hash()) {
                continue;
            }
            let entry = self.log.get(&change.hash()).ok_or(SyncError::Invalid)?;
            let size = wire::canonical(entry)?.len();
            if size > MAX_PAYLOAD_BYTES / 2 {
                return Err(SyncError::Limit);
            }
            if bytes + size + 2 > MAX_PAYLOAD_BYTES && !batch.is_empty() {
                frames.push(EncryptedFrame::seal(&self.binding, &self.key, &batch)?);
                batch.clear();
                bytes = 0;
            }
            bytes += size + 1;
            batch.push(entry.clone());
        }
        if !batch.is_empty() {
            frames.push(EncryptedFrame::seal(&self.binding, &self.key, &batch)?);
        }
        Ok(frames)
    }
    pub fn known(&self) -> BTreeSet<ChangeHash> {
        self.log.keys().copied().collect()
    }
    /// Entire frame is staged and validated before committing any durable-visible state.
    pub fn receive(
        &mut self,
        frame: &EncryptedFrame,
        roster: &[VerifiedMembership],
    ) -> Result<usize> {
        self.receive_entries(frame.open(&self.binding, &self.key)?, roster)
    }
    fn receive_entries(
        &mut self,
        entries: Vec<wire::SignedChange>,
        roster: &[VerifiedMembership],
    ) -> Result<usize> {
        let mut log = self.log.clone();
        let mut changes = Vec::new();
        let mut sequences = BTreeMap::new();
        for change in self.doc.get_changes(&[]) {
            sequences.insert((change.actor_id().clone(), change.seq()), change.hash());
        }
        for entry in entries {
            let member = roster
                .iter()
                .find(|member| member.device().id == entry.device)
                .ok_or(SyncError::Authorization)?;
            if member.document() != self.key.context()
                || member.generation() != self.binding.generation
                || member.authority() != &self.authority
                || member.root_epoch() != self.root_epoch
                || member.role() != DocumentRole::Write
            {
                return Err(SyncError::Authorization);
            }
            let change =
                entry.verify(&self.binding, member, self.app.application(), &self.scope)?;
            if let Some(hash) =
                sequences.insert((change.actor_id().clone(), change.seq()), change.hash())
                && hash != change.hash()
            {
                return Err(SyncError::Invalid);
            }
            if let Some(existing) = log.get(&change.hash()) {
                if existing.change != entry.change {
                    return Err(SyncError::Invalid);
                }
                continue;
            }
            log.insert(change.hash(), entry);
            changes.push(change);
        }
        Self::check_log(&log)?;
        for (actor, sequence) in sequences.keys() {
            if *sequence > 1 && !sequences.contains_key(&(actor.clone(), sequence - 1)) {
                return Err(SyncError::MissingDependencies);
            }
        }
        // Missing histories are explicit retry requests, never silently queued unboundedly.
        let mut available = self.known();
        available.extend(changes.iter().map(Change::hash));
        if changes
            .iter()
            .any(|change| change.deps().iter().any(|dep| !available.contains(dep)))
        {
            return Err(SyncError::MissingDependencies);
        }
        wire::validate_history(self.doc.get_changes(&[]), &changes)?;
        let mut candidate = self.doc.clone();
        candidate
            .apply_changes(changes.clone())
            .map_err(|_| SyncError::Invalid)?;
        let state = mapping::project(&candidate, &self.state, self.app.application(), &self.scope)?;
        self.doc = candidate;
        self.state = state;
        self.log = log;
        Ok(changes.len())
    }
    /// Rebuild from authenticated change history, including after all local clients closed.
    pub fn checkpoint(&self) -> Result<EncryptedFrame> {
        EncryptedFrame::seal(
            &self.binding,
            &self.key,
            &self.log.values().cloned().collect::<Vec<_>>(),
        )
    }
    /// Stable identity per account/application/instance; different installations remain distinct.
    pub fn document_id(account: &str, application: &str, instance: &str) -> Result<String> {
        for value in [account, application, instance] {
            let parsed = uuid::Uuid::parse_str(value).map_err(|_| SyncError::Invalid)?;
            if parsed.to_string() != value {
                return Err(SyncError::Invalid);
            }
        }
        let digest = blake3::hash(&wire::canonical(&(
            "needware document identity v1",
            account,
            application,
            instance,
        ))?);
        let mut bytes = [0; 16];
        bytes.copy_from_slice(&digest.as_bytes()[..16]);
        bytes[6] = (bytes[6] & 0x0f) | 0x80;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Ok(uuid::Uuid::from_bytes(bytes).to_string())
    }
}
