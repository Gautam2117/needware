use super::*;
use automerge::legacy::{Key, ObjectId, OpType};
use needware_ir::Application;
use serde::de::DeserializeOwned;

pub(crate) fn canonical<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json_canonicalizer::to_vec(value).map_err(|_| SyncError::Invalid)
}
pub(crate) fn decode<T: DeserializeOwned + Serialize>(bytes: &[u8]) -> Result<T> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(SyncError::Limit);
    }
    let value: T = serde_json::from_slice(bytes).map_err(|_| SyncError::Invalid)?;
    // A single canonical representation rejects duplicate/unknown/aliased fields.
    if canonical(&value)? != bytes {
        return Err(SyncError::Invalid);
    }
    Ok(value)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SignedChange {
    pub device: String,
    pub change: String,
    pub operations: usize,
    pub signature: Vec<u8>,
}
impl SignedChange {
    pub(crate) fn message(&self, binding: &Binding) -> Result<Vec<u8>> {
        canonical(&(
            "NEEDWARE-SYNC-CHANGE-v1",
            binding,
            &self.device,
            hex::encode(blake3::hash(self.change.as_bytes()).as_bytes()),
            self.operations,
        ))
    }
    pub(crate) fn create(binding: &Binding, device: &DeviceKeys, change: &Change) -> Result<Self> {
        let expanded = change.decode();
        if expanded.deps.len() > 128
            || expanded.operations.len() > 4096
            || expanded.operations.is_empty()
            || expanded.operations.iter().any(|op| op.pred.len() > 128)
        {
            return Err(SyncError::Limit);
        }
        let mut entry = Self {
            device: device.public().map_err(|_| SyncError::Authorization)?.id,
            change: String::from_utf8(canonical(&expanded)?).map_err(|_| SyncError::Invalid)?,
            operations: change.len(),
            signature: Vec::new(),
        };
        entry.signature = device
            .sign(&entry.message(binding)?)
            .map_err(|_| SyncError::Authorization)?
            .to_vec();
        if canonical(&entry)?.len() > MAX_PAYLOAD_BYTES / 2 {
            return Err(SyncError::Limit);
        }
        Ok(entry)
    }
    pub(crate) fn verify(
        &self,
        binding: &Binding,
        member: &VerifiedMembership,
        app: &Application,
        scope: &Scope,
    ) -> Result<Change> {
        if self.signature.len() != 64 || self.device != member.device().id {
            return Err(SyncError::Authorization);
        }
        let signature = self
            .signature
            .as_slice()
            .try_into()
            .map_err(|_| SyncError::Authorization)?;
        needware_crypto::verify(&member.device().signing, &self.message(binding)?, signature)
            .map_err(|_| SyncError::Authorization)?;
        // Expanded JSON contains no DEFLATE/RLE streams, preventing compressed allocation bombs.
        let expanded: automerge::ExpandedChange = decode(self.change.as_bytes())?;
        if expanded.actor_id.to_bytes().len() != 48
            || expanded.actor_id.to_bytes()[..32] != member.device().signing
            || expanded.operations.len() != self.operations
            || self.operations == 0
            || self.operations > 4096
            || expanded.deps.len() > 128
            || !expanded.extra_bytes.is_empty()
            || expanded.author.is_some()
            || expanded.message.is_some()
            || expanded.time != 0
            || expanded.seq == 0
            || expanded.seq > MAX_OPERATIONS as u64
            || expanded
                .start_op
                .get()
                .checked_add(self.operations as u64)
                .is_none_or(|end| end > MAX_OPERATIONS as u64 + 1)
        {
            return Err(SyncError::Limit);
        }
        let mut dependencies = BTreeSet::new();
        if expanded.deps.iter().any(|hash| !dependencies.insert(*hash)) {
            return Err(SyncError::Invalid);
        }
        for op in &expanded.operations {
            if op.obj != ObjectId::Root || op.insert || op.pred.len() > 128 {
                return Err(SyncError::Invalid);
            }
            let Key::Map(key) = &op.key else {
                return Err(SyncError::Invalid);
            };
            let address = mapping::Address::parse(key, app, scope)?;
            let OpType::Put(ScalarValue::Str(text)) = &op.action else {
                return Err(SyncError::Invalid);
            };
            mapping::validate_cell(&address, text, app)?;
            let mut previous = BTreeSet::new();
            for pred in op.pred.iter() {
                if pred.0 == 0
                    || pred.0 > MAX_OPERATIONS as u64
                    || pred.1.to_bytes().len() != 48
                    || !previous.insert(pred.clone())
                {
                    return Err(SyncError::Invalid);
                }
            }
        }
        let expected_hash = expanded.hash.ok_or(SyncError::Invalid)?;
        let change = Change::from(expanded);
        if change.hash() != expected_hash {
            return Err(SyncError::Invalid);
        }
        Ok(change)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EncryptedFrame {
    pub binding: Binding,
    pub ciphertext: Vec<u8>,
}
pub(crate) fn validate_history(previous: Vec<Change>, incoming: &[Change]) -> Result<()> {
    let history: BTreeMap<_, _> = previous
        .iter()
        .chain(incoming.iter())
        .map(|change| (change.hash(), change.decode()))
        .collect();
    let mut owners = BTreeMap::new();
    for (hash, change) in &history {
        for (offset, op) in change.operations.iter().enumerate() {
            let Key::Map(key) = &op.key else {
                return Err(SyncError::Invalid);
            };
            let id = automerge::legacy::OpId(
                change.start_op.get() + offset as u64,
                change.actor_id.clone(),
            );
            if owners.insert(id, (key.clone(), *hash)).is_some() {
                return Err(SyncError::Invalid);
            }
        }
    }
    let mut work = 1_000_000_u32;
    for change in incoming {
        let expanded = history.get(&change.hash()).ok_or(SyncError::Invalid)?;
        let mut ancestors = BTreeSet::new();
        let mut pending = expanded.deps.clone();
        while let Some(hash) = pending.pop() {
            work = work.checked_sub(1).ok_or(SyncError::Limit)?;
            if ancestors.insert(hash) {
                pending.extend(
                    &history
                        .get(&hash)
                        .ok_or(SyncError::MissingDependencies)?
                        .deps,
                );
            }
        }
        if ancestors.contains(&change.hash()) {
            return Err(SyncError::Invalid);
        }
        if expanded.seq > 1
            && !ancestors.iter().any(|hash| {
                let previous = &history[hash];
                previous.actor_id == expanded.actor_id && previous.seq == expanded.seq - 1
            })
        {
            return Err(SyncError::Invalid);
        }
        for (offset, op) in expanded.operations.iter().enumerate() {
            let Key::Map(key) = &op.key else {
                return Err(SyncError::Invalid);
            };
            for predecessor in op.pred.iter() {
                work = work.checked_sub(1).ok_or(SyncError::Limit)?;
                let (previous_key, hash) = owners.get(predecessor).ok_or(SyncError::Invalid)?;
                if previous_key != key
                    || (*hash != change.hash() && !ancestors.contains(hash))
                    || (*hash == change.hash()
                        && predecessor.0 >= expanded.start_op.get() + offset as u64)
                {
                    return Err(SyncError::Invalid);
                }
            }
        }
    }
    Ok(())
}
impl EncryptedFrame {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        // JSON ciphertext arrays have overhead but their decoded bytes retain a stricter cap.
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(SyncError::Limit);
        }
        let frame: Self = serde_json::from_slice(bytes).map_err(|_| SyncError::Invalid)?;
        if frame.ciphertext.len() > MAX_FRAME_BYTES
            || frame.ciphertext.len() < 40
            || frame.binding.protocol != 1
        {
            return Err(SyncError::Protocol);
        }
        if canonical(&frame)? != bytes {
            return Err(SyncError::Invalid);
        }
        Ok(frame)
    }
    fn metadata(binding: &Binding) -> Result<Vec<u8>> {
        Ok(
            blake3::hash(&canonical(&("NEEDWARE-SYNC-FRAME-v1", binding))?)
                .as_bytes()
                .to_vec(),
        )
    }
    pub(crate) fn seal(
        binding: &Binding,
        key: &DocumentKey,
        entries: &[SignedChange],
    ) -> Result<Self> {
        let plaintext = zeroize::Zeroizing::new(canonical(&entries)?);
        if plaintext.len() > MAX_PAYLOAD_BYTES || entries.len() > 4096 {
            return Err(SyncError::Limit);
        }
        let frame = Self {
            binding: binding.clone(),
            ciphertext: key
                .seal(&plaintext, &Self::metadata(binding)?)
                .map_err(|_| SyncError::Invalid)?,
        };
        if canonical(&frame)?.len() > MAX_FRAME_BYTES {
            return Err(SyncError::Limit);
        }
        Ok(frame)
    }
    pub(crate) fn open(&self, expected: &Binding, key: &DocumentKey) -> Result<Vec<SignedChange>> {
        if &self.binding != expected {
            return Err(SyncError::Protocol);
        }
        if self.ciphertext.len() > MAX_PAYLOAD_BYTES + 40 {
            return Err(SyncError::Limit);
        }
        let bytes = key
            .open(&self.ciphertext, &Self::metadata(expected)?)
            .map_err(|_| SyncError::Authorization)?;
        let entries: Vec<SignedChange> = decode(&bytes)?;
        if entries.len() > 4096 {
            return Err(SyncError::Limit);
        }
        Ok(entries)
    }
}
