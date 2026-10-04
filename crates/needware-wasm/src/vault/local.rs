use super::*;
use zeroize::Zeroize;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RootBackup {
    context: KeyContext,
    authority: [u8; 32],
    envelope: DeviceEnvelope,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalBackup {
    version: u16,
    device: DevicePublic,
    lock: [u8; 32],
    locked_device: Vec<u8>,
    root: Option<RootBackup>,
    documents: Vec<WrappedKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    held_documents: Option<Vec<HeldDocumentKey>>,
}
impl Drop for LocalBackup {
    fn drop(&mut self) {
        self.lock.zeroize();
    }
}
#[wasm_bindgen]
impl BrowserVault {
    /// Sensitive transient bytes: encrypt with a host-held non-extractable local key, then wipe.
    /// Never upload or persist this buffer directly.
    pub fn local_backup(&self) -> Result<Vec<u8>, JsValue> {
        let lock = SecretKey::random().map_err(error)?;
        let device = self.device.public().map_err(error)?;
        let root = self
            .root
            .as_ref()
            .map(|root| -> Result<RootBackup, JsValue> {
                let certified = root
                    .certify_device(device.clone())
                    .map_err(error)?
                    .verify(root.context(), &root.authority().map_err(error)?)
                    .map_err(error)?;
                Ok(RootBackup {
                    context: root.context().clone(),
                    authority: root.authority().map_err(error)?,
                    envelope: root.enroll_device(&certified).map_err(error)?,
                })
            })
            .transpose()?;
        let documents = self
            .documents
            .values()
            .map(|key| self.root()?.wrap_held_document(key).map_err(error))
            .collect::<Result<Vec<_>, _>>()?;
        let backup = LocalBackup {
            version: 2,
            device,
            lock: *lock.bytes(),
            locked_device: self.device.lock_local(&lock).map_err(error)?,
            root,
            documents: vec![],
            held_documents: Some(documents),
        };
        needware_package::canonical(&backup).map_err(error)
    }
    pub fn from_local_backup(bytes: &[u8]) -> Result<BrowserVault, JsValue> {
        let backup: LocalBackup = needware_package::parse_json(bytes).map_err(error)?;
        if ![1, 2].contains(&backup.version)
            || backup.documents.len() > 256
            || backup
                .held_documents
                .as_ref()
                .is_some_and(|docs| docs.len() > 256)
            || (backup.version == 1 && backup.held_documents.is_some())
            || (backup.version == 2
                && (!backup.documents.is_empty() || backup.held_documents.is_none()))
        {
            return Err(error("unsupported local vault backup"));
        }
        backup.device.validate().map_err(error)?;
        let device = DeviceKeys::unlock_local(
            &backup.device.id,
            &backup.locked_device,
            &SecretKey::from_bytes(backup.lock),
        )
        .map_err(error)?;
        if device.public().map_err(error)? != backup.device {
            return Err(error("device backup identity mismatch"));
        }
        let root = backup
            .root
            .as_ref()
            .map(|root| {
                device
                    .open_account(&root.envelope, &root.context, &root.authority)
                    .map_err(error)
            })
            .transpose()?;
        let mut documents = BTreeMap::new();
        for envelope in &backup.documents {
            let key = root
                .as_ref()
                .ok_or_else(|| error("owner root required for document backups"))?
                .unwrap_document(envelope, &envelope.context)
                .map_err(error)?;
            let id = envelope
                .context
                .document
                .as_ref()
                .ok_or_else(|| error("invalid document backup"))?;
            if documents.insert(id.clone(), key).is_some() {
                return Err(error("duplicate document backup"));
            }
        }
        for envelope in backup.held_documents.iter().flatten() {
            let key = root
                .as_ref()
                .ok_or_else(|| error("account root required for held document backups"))?
                .unwrap_held_document(envelope, &envelope.document)
                .map_err(error)?;
            let id = envelope
                .document
                .document
                .as_ref()
                .ok_or_else(|| error("invalid held document context"))?;
            if documents.insert(id.clone(), key).is_some() {
                return Err(error("duplicate document backup"));
            }
        }
        Ok(BrowserVault {
            device,
            root,
            documents,
        })
    }
}
