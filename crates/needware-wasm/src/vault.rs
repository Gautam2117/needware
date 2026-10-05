//! Opaque keys live in Rust handles owned by the trusted browser host, never the app frame.
pub(crate) mod generation;
mod local;
mod revision;
use super::error;
use needware_capabilities::{Capability, Grants};
use needware_crypto::SecretKey;
use needware_sync::{EncryptedFrame, EpochTrust, Replica, RootEpochTrust, Scope};
use needware_vault::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;
fn json<T: Serialize>(value: &T) -> Result<String, JsValue> {
    String::from_utf8(needware_package::canonical(value).map_err(error)?).map_err(error)
}
fn parse<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, JsValue> {
    if value.len() > 32 * 1024 {
        return Err(error("vault input limit"));
    }
    needware_package::parse_json(value.as_bytes()).map_err(error)
}
fn authority(value: &str) -> Result<[u8; 32], JsValue> {
    hex::decode(value)
        .map_err(error)?
        .try_into()
        .map_err(|_| error("invalid authority"))
}
fn copy_device(device: &DeviceKeys) -> Result<DeviceKeys, JsValue> {
    let temporary = SecretKey::random().map_err(error)?;
    DeviceKeys::unlock_local(
        &device.public().map_err(error)?.id,
        &device.lock_local(&temporary).map_err(error)?,
        &temporary,
    )
    .map_err(error)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Enrollment {
    certificate: DeviceCertificate,
    envelope: DeviceEnvelope,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Offer {
    envelope: DeviceEnvelope,
    membership: DocumentMembership,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Recovery {
    code: String,
    envelope: RecoveryEnvelope,
}
#[wasm_bindgen]
pub struct BrowserVault {
    device: DeviceKeys,
    root: Option<AccountVault>,
    documents: BTreeMap<String, DocumentKey>,
}
#[wasm_bindgen]
pub struct BrowserRootRotation {
    previous: AccountVault,
    candidate: BrowserVault,
    proof: RootRotation,
}
#[wasm_bindgen]
impl BrowserRootRotation {
    /// The source stays live until the host commits every document and the cloud root together.
    pub fn preview(&self) -> Result<BrowserVault, JsValue> {
        let mut backup = self.candidate.local_backup()?;
        let candidate = BrowserVault::from_local_backup(&backup);
        zeroize::Zeroize::zeroize(&mut backup);
        candidate
    }
    pub fn proof(&self) -> Result<String, JsValue> {
        json(&self.proof)
    }
    pub fn rewrap_held_backup(&self, held: &str, context: &str) -> Result<String, JsValue> {
        let key = self
            .previous
            .unwrap_held_document(&parse(held)?, &parse(context)?)
            .map_err(error)?;
        json(
            &self
                .candidate
                .root()?
                .wrap_held_document(&key)
                .map_err(error)?,
        )
    }
}
impl BrowserVault {
    fn root(&self) -> Result<&AccountVault, JsValue> {
        self.root
            .as_ref()
            .ok_or_else(|| error("trusted device enrollment or recovery required"))
    }
}
#[wasm_bindgen]
impl BrowserVault {
    /// Account namespace comes from the host's authenticated identity boundary.
    #[wasm_bindgen(constructor)]
    pub fn new(account: Option<String>) -> Result<Self, JsValue> {
        Ok(Self {
            device: DeviceKeys::create().map_err(error)?,
            root: account
                .map(|account| AccountVault::create(&account))
                .transpose()
                .map_err(error)?,
            documents: BTreeMap::new(),
        })
    }
    pub fn prepare_root_rotation(&self, approved: bool) -> Result<BrowserRootRotation, JsValue> {
        if !approved {
            return Err(error("explicit root rotation approval required"));
        }
        let mut backup = self.local_backup()?;
        let cloned = BrowserVault::from_local_backup(&backup);
        zeroize::Zeroize::zeroize(&mut backup);
        let previous = cloned?
            .root
            .ok_or_else(|| error("account root unavailable"))?;
        let next = previous.rotate().map_err(error)?;
        let proof = previous.accepted_rotation_to(&next).map_err(error)?;
        Ok(BrowserRootRotation {
            previous,
            candidate: BrowserVault {
                device: copy_device(&self.device)?,
                root: Some(next),
                documents: self
                    .documents
                    .iter()
                    .map(|(id, key)| (id.clone(), key.fork_session()))
                    .collect(),
            },
            proof,
        })
    }
    pub fn device_public(&self) -> Result<String, JsValue> {
        json(&self.device.public().map_err(error)?)
    }
    pub fn enrolled(&self) -> bool {
        self.root.is_some()
    }
    pub fn account_context(&self) -> Result<String, JsValue> {
        json(self.root()?.context())
    }
    pub fn account_authority(&self) -> Result<String, JsValue> {
        Ok(hex::encode(self.root()?.authority().map_err(error)?))
    }
    pub fn device_certificate(&self) -> Result<String, JsValue> {
        json(
            &self
                .root()?
                .certify_device(self.device.public().map_err(error)?)
                .map_err(error)?,
        )
    }
    pub fn account_operation(
        &self,
        nonce: &str,
        operation: &str,
        digest: &str,
    ) -> Result<String, JsValue> {
        let root = self.root()?;
        let verified = root
            .certify_device(self.device.public().map_err(error)?)
            .map_err(error)?
            .verify(root.context(), &root.authority().map_err(error)?)
            .map_err(error)?;
        json(
            &self
                .device
                .account_operation(&verified, nonce, parse(operation)?, authority(digest)?)
                .map_err(error)?,
        )
    }
    /// Approval is a host decision after showing the actual recipient identity/fingerprint.
    pub fn approve_device(&self, recipient: &str, approved: bool) -> Result<String, JsValue> {
        if !approved {
            return Err(error("explicit recipient approval required"));
        }
        let certificate = self
            .root()?
            .certify_device(parse(recipient)?)
            .map_err(error)?;
        let verified = certificate
            .verify(
                self.root()?.context(),
                &self.root()?.authority().map_err(error)?,
            )
            .map_err(error)?;
        json(&Enrollment {
            certificate,
            envelope: self.root()?.enroll_device(&verified).map_err(error)?,
        })
    }
    /// A retained browser verifies the forward chain from its own old root before
    /// opening its new HPKE approval. Publication remains the host's transaction.
    pub fn accept_root_rotation(
        &self,
        proof: &str,
        enrollment: &str,
        expected_context: &str,
        pinned_authority: &str,
    ) -> Result<BrowserRootRotation, JsValue> {
        let proof: RootRotation = parse(proof)?;
        let previous = self.root()?;
        let next = proof
            .verify(previous.context(), &previous.authority().map_err(error)?)
            .map_err(error)?;
        let expected = parse(expected_context)?;
        let pin = authority(pinned_authority)?;
        if next.context() != &expected || next.public() != &pin {
            return Err(error("root rotation directory pin mismatch"));
        }
        let enrollment: Enrollment = parse(enrollment)?;
        let device = enrollment
            .certificate
            .verify(&expected, &pin)
            .map_err(error)?;
        if device.public() != &self.device.public().map_err(error)? {
            return Err(error("wrong root rotation recipient"));
        }
        let root = self
            .device
            .open_account(&enrollment.envelope, &expected, &pin)
            .map_err(error)?;
        let mut backup = self.local_backup()?;
        let candidate = Self::from_local_backup(&backup);
        zeroize::Zeroize::zeroize(&mut backup);
        let mut candidate = candidate?;
        let previous = candidate
            .root
            .replace(root)
            .ok_or_else(|| error("account root unavailable"))?;
        Ok(BrowserRootRotation {
            previous,
            candidate,
            proof,
        })
    }
    pub fn accept_enrollment(
        &mut self,
        enrollment: &str,
        expected_context: &str,
        pinned_authority: &str,
    ) -> Result<(), JsValue> {
        if self.root.is_some() {
            return Err(error(
                "device is already enrolled; existing vault preserved",
            ));
        }
        let enrollment: Enrollment = parse(enrollment)?;
        let expected = parse(expected_context)?;
        let pin = authority(pinned_authority)?;
        let device = enrollment
            .certificate
            .verify(&expected, &pin)
            .map_err(error)?;
        if device.public() != &self.device.public().map_err(error)? {
            return Err(error("wrong recipient"));
        }
        let root = self
            .device
            .open_account(&enrollment.envelope, &expected, &pin)
            .map_err(error)?;
        self.root = Some(root);
        Ok(())
    }
    /// One-time display/export; the service only receives the encrypted envelope.
    pub fn create_recovery(&self, approved: bool) -> Result<String, JsValue> {
        if !approved {
            return Err(error("recovery code display approval required"));
        }
        let code = RecoveryCode::create().map_err(error)?;
        json(&Recovery {
            envelope: self.root()?.recovery_envelope(&code).map_err(error)?,
            code: code.export().to_string(),
        })
    }
    pub fn recover(
        &mut self,
        code: &str,
        envelope: &str,
        expected_context: &str,
        pinned_authority: &str,
    ) -> Result<(), JsValue> {
        if self.root.is_some() {
            return Err(error("existing vault must be preserved"));
        }
        let root = AccountVault::recover(
            &RecoveryCode::parse(code).map_err(error)?,
            &RecoveryEnvelope::parse(envelope.as_bytes()).map_err(error)?,
            &parse(expected_context)?,
        )
        .map_err(error)?;
        if root.authority().map_err(error)? != authority(pinned_authority)? {
            return Err(error("account authority mismatch"));
        }
        self.root = Some(root);
        Ok(())
    }
    pub fn start_document(
        &mut self,
        package: &[u8],
        instance: &str,
        scope: &str,
        schema_epoch: u32,
        consent: bool,
    ) -> Result<BrowserSync, JsValue> {
        if !consent {
            return Err(error("package and sync scope consent required"));
        }
        let package = needware_package::verify(package).map_err(error)?;
        let scope: Scope = parse(scope)?;
        check_scope(package.application().application(), &scope, true)?;
        let id = Replica::document_id(
            &self.root()?.context().account,
            &package.application().application().id,
            instance,
        )
        .map_err(error)?;
        if self.documents.len() >= 256 {
            return Err(error("document key limit"));
        }
        if self.documents.contains_key(&id) {
            return Err(error("document exists; retain or reopen its existing key"));
        }
        let key = self.root()?.create_document(&id).map_err(error)?;
        let certified = self
            .root()?
            .certify_device(self.device.public().map_err(error)?)
            .map_err(error)?
            .verify(
                self.root()?.context(),
                &self.root()?.authority().map_err(error)?,
            )
            .map_err(error)?;
        let membership = self
            .root()?
            .document_membership(&key, &certified, DocumentRole::Write, 1)
            .map_err(error)?;
        let copied_key = self
            .root()?
            .unwrap_document(
                &self.root()?.wrap_document(&key).map_err(error)?,
                key.context(),
            )
            .map_err(error)?;
        let session = BrowserSync::new(
            package,
            scope,
            copied_key,
            copy_device(&self.device)?,
            membership,
            self.root()?.context().epoch,
            self.root()?.authority().map_err(error)?,
            schema_epoch,
        )?;
        self.documents.insert(id, key);
        Ok(session)
    }
    pub fn document_key_backup(&self, document: &str) -> Result<String, JsValue> {
        let key = self
            .documents
            .get(document)
            .ok_or_else(|| error("document key unavailable"))?;
        json(&self.root()?.wrap_document(key).map_err(error)?)
    }
    pub fn held_document_key_backup(&self, document: &str) -> Result<String, JsValue> {
        let key = self
            .documents
            .get(document)
            .ok_or_else(|| error("document key unavailable"))?;
        json(&self.root()?.wrap_held_document(key).map_err(error)?)
    }
    pub fn has_document(&self, document: &str) -> bool {
        self.documents.contains_key(document)
    }
    pub fn forget_document(&mut self, document: &str) {
        self.documents.remove(document);
    }
    pub fn open_document_payload(
        &self,
        document: &str,
        ciphertext: &[u8],
        metadata: &str,
    ) -> Result<Vec<u8>, JsValue> {
        self.documents
            .get(document)
            .ok_or_else(|| error("document key unavailable"))?
            .open(ciphertext, metadata.as_bytes())
            .map_err(error)
            .map(|bytes| bytes.to_vec())
    }
    pub fn own_document_membership(
        &self,
        document: &str,
        generation: u32,
    ) -> Result<String, JsValue> {
        let key = self
            .documents
            .get(document)
            .ok_or_else(|| error("document key unavailable"))?;
        let root = self.root()?;
        let recipient = root
            .certify_device(self.device.public().map_err(error)?)
            .map_err(error)?
            .verify(root.context(), &root.authority().map_err(error)?)
            .map_err(error)?;
        json(
            &root
                .document_membership(key, &recipient, DocumentRole::Write, generation)
                .map_err(error)?,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn accept_document_key(
        &mut self,
        offer: &str,
        expected: &str,
        owner_epoch: u32,
        pin: &str,
        generation: u32,
        consent: bool,
    ) -> Result<(), JsValue> {
        if !consent {
            return Err(error("document sharing consent required"));
        }
        self.root()?;
        let expected: KeyContext = parse(expected)?;
        let id = expected
            .document
            .as_ref()
            .ok_or_else(|| error("invalid document context"))?;
        if self.documents.len() >= 256 || self.documents.contains_key(id) {
            return Err(error("existing keys preserved or key limit"));
        }
        let offer: Offer = parse(offer)?;
        let pin = authority(pin)?;
        let member = offer
            .membership
            .verify(&expected, owner_epoch, &pin, generation)
            .map_err(error)?;
        if member.device() != &self.device.public().map_err(error)? {
            return Err(error("wrong document recipient"));
        }
        let key = self
            .device
            .open_document(&offer.envelope, &expected, owner_epoch, &pin)
            .map_err(error)?;
        self.documents.insert(id.clone(), key);
        Ok(())
    }
    pub fn restore_held_document_key(
        &mut self,
        backup: &str,
        expected_document: &str,
    ) -> Result<(), JsValue> {
        let context: KeyContext = parse(expected_document)?;
        if self.documents.len() >= 256 {
            return Err(error("document key limit"));
        }
        let id = context
            .document
            .as_ref()
            .ok_or_else(|| error("invalid document context"))?;
        if self.documents.contains_key(id) {
            return Err(error("existing document key preserved"));
        }
        let envelope = HeldDocumentKey::parse(backup.as_bytes()).map_err(error)?;
        let key = self
            .root()?
            .unwrap_held_document(&envelope, &context)
            .map_err(error)?;
        self.documents.insert(id.clone(), key);
        Ok(())
    }
    pub fn restore_document_key(
        &mut self,
        backup: &str,
        expected_document: &str,
    ) -> Result<(), JsValue> {
        let context: KeyContext = parse(expected_document)?;
        if self.documents.len() >= 256 {
            return Err(error("document key limit"));
        }
        let id = context
            .document
            .as_ref()
            .ok_or_else(|| error("invalid document context"))?;
        if self.documents.contains_key(id) {
            return Err(error("existing document key preserved"));
        }
        let backup = WrappedKey::parse(backup.as_bytes()).map_err(error)?;
        let key = self
            .root()?
            .unwrap_document(&backup, &context)
            .map_err(error)?;
        self.documents.insert(id.clone(), key);
        Ok(())
    }
    pub fn open_document(
        &self,
        package: &[u8],
        document: &str,
        scope: &str,
        schema_epoch: u32,
        generation: u32,
        consent: bool,
    ) -> Result<BrowserSync, JsValue> {
        if !consent {
            return Err(error("package and sync scope consent required"));
        }
        let package = needware_package::verify(package).map_err(error)?;
        let scope: Scope = parse(scope)?;
        check_scope(package.application().application(), &scope, true)?;
        let key = self
            .documents
            .get(document)
            .ok_or_else(|| error("document key unavailable"))?;
        // Application/scope binding is independently verified by the restored frame.
        let recipient = self
            .root()?
            .certify_device(self.device.public().map_err(error)?)
            .map_err(error)?
            .verify(
                self.root()?.context(),
                &self.root()?.authority().map_err(error)?,
            )
            .map_err(error)?;
        let membership = self
            .root()?
            .document_membership(key, &recipient, DocumentRole::Write, generation)
            .map_err(error)?;
        let copy = self
            .root()?
            .unwrap_document(
                &self.root()?.wrap_document(key).map_err(error)?,
                key.context(),
            )
            .map_err(error)?;
        BrowserSync::new(
            package,
            scope,
            copy,
            copy_device(&self.device)?,
            membership,
            self.root()?.context().epoch,
            self.root()?.authority().map_err(error)?,
            schema_epoch,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn open_shared_document(
        &self,
        package: &[u8],
        document: &str,
        membership: &str,
        owner_epoch: u32,
        owner_authority: &str,
        generation: u32,
        scope: &str,
        schema_epoch: u32,
        consent: bool,
    ) -> Result<BrowserSync, JsValue> {
        if !consent {
            return Err(error("package and sync scope consent required"));
        }
        let key = self
            .documents
            .get(document)
            .ok_or_else(|| error("held document key unavailable"))?;
        let membership: DocumentMembership = parse(membership)?;
        let pin = authority(owner_authority)?;
        let verified = membership
            .verify(key.context(), owner_epoch, &pin, generation)
            .map_err(error)?;
        if verified.device() != &self.device.public().map_err(error)? {
            return Err(error("document membership belongs to another device"));
        }
        let package = needware_package::verify(package).map_err(error)?;
        let scope: Scope = parse(scope)?;
        check_scope(
            package.application().application(),
            &scope,
            verified.role() == DocumentRole::Write,
        )?;
        BrowserSync::new(
            package,
            scope,
            key.fork_session(),
            self.device.fork_session(),
            membership,
            owner_epoch,
            pin,
            schema_epoch,
        )
    }
    pub fn offer_document(
        &self,
        document: &str,
        recipient_certificate: &str,
        recipient_context: &str,
        recipient_authority: &str,
        write: bool,
        approved: bool,
    ) -> Result<String, JsValue> {
        if !approved {
            return Err(error("explicit document sharing approval required"));
        }
        let key = self
            .documents
            .get(document)
            .ok_or_else(|| error("document key unavailable"))?;
        let certificate: DeviceCertificate = parse(recipient_certificate)?;
        let recipient = certificate
            .verify(&parse(recipient_context)?, &authority(recipient_authority)?)
            .map_err(error)?;
        let role = if write {
            DocumentRole::Write
        } else {
            DocumentRole::Read
        };
        json(&Offer {
            envelope: self
                .root()?
                .share_document(key, &recipient)
                .map_err(error)?,
            membership: self
                .root()?
                .document_membership(key, &recipient, role, key.context().epoch)
                .map_err(error)?,
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn join_document(
        &mut self,
        package: &[u8],
        offer: &str,
        expected_document: &str,
        owner_root_epoch: u32,
        owner_authority: &str,
        generation: u32,
        scope: &str,
        schema_epoch: u32,
        consent: bool,
    ) -> Result<BrowserSync, JsValue> {
        if !consent {
            return Err(error("package and sync scope consent required"));
        }
        let offer: Offer = parse(offer)?;
        let expected: KeyContext = parse(expected_document)?;
        self.root()?;
        if self.documents.len() >= 256 {
            return Err(error("document key limit"));
        }
        let id = expected
            .document
            .as_ref()
            .ok_or_else(|| error("invalid document context"))?;
        if self.documents.contains_key(id) {
            return Err(error("existing document key preserved; reopen its session"));
        }
        let pin = authority(owner_authority)?;
        let membership = offer
            .membership
            .verify(&expected, owner_root_epoch, &pin, generation)
            .map_err(error)?;
        if membership.device() != &self.device.public().map_err(error)? {
            return Err(error("wrong recipient"));
        }
        let key = self
            .device
            .open_document(&offer.envelope, &expected, owner_root_epoch, &pin)
            .map_err(error)?;
        let package = needware_package::verify(package).map_err(error)?;
        let scope: Scope = parse(scope)?;
        check_scope(
            package.application().application(),
            &scope,
            membership.role() == DocumentRole::Write,
        )?;
        let saved = key.fork_session();
        let session = BrowserSync::new(
            package,
            scope,
            key,
            copy_device(&self.device)?,
            offer.membership,
            owner_root_epoch,
            pin,
            schema_epoch,
        )?;
        self.documents.insert(id.clone(), saved);
        Ok(session)
    }
}
fn check_scope(app: &needware_ir::Application, scope: &Scope, write: bool) -> Result<(), JsValue> {
    // Encrypting a wholly device-local document does not grant collaboration.
    if scope.values.is_empty() && scope.collections.is_empty() {
        return Ok(());
    }
    if !app.capabilities.iter().any(|capability| {
        matches!(capability,
        Capability::Collaboration { write: granted } if !write || *granted)
    }) {
        return Err(error("declared collaboration permission required"));
    }
    for name in &scope.collections {
        if !app.capabilities.iter().any(|capability| {
            matches!(capability,
            Capability::Storage { synchronized: true, write: granted, collections }
                if (!write || *granted) && collections.contains(name))
        }) {
            return Err(error(
                "collection lacks declared synchronized storage scope",
            ));
        }
    }
    Ok(())
}
#[wasm_bindgen]
pub struct BrowserSync {
    replica: Replica,
    runtime: needware_runtime::Runtime,
    membership: DocumentMembership,
    roster: Vec<VerifiedMembership>,
    owner_epoch: u32,
    authority: [u8; 32],
}
#[wasm_bindgen]
pub struct BrowserEpoch {
    previous: KeyContext,
    next_key: Option<DocumentKey>,
    session: Option<BrowserSync>,
    held: HeldDocumentKey,
    checkpoint: Vec<u8>,
    transition: DocumentTransition,
    archive: Vec<EncryptedFrame>,
}
#[wasm_bindgen]
impl BrowserEpoch {
    /// Issue the staged key only to an explicitly approved, independently pinned recipient.
    pub fn offer_document(
        &self,
        vault: &BrowserVault,
        recipient_certificate: &str,
        recipient_context: &str,
        recipient_authority: &str,
        write: bool,
        approved: bool,
    ) -> Result<String, JsValue> {
        if !approved {
            return Err(error("explicit retained recipient approval required"));
        }
        let root = vault.root()?;
        if root.context() != &self.transition.root
            || root.authority().map_err(error)? != self.transition.authority
        {
            return Err(error("staged epoch owner authority mismatch"));
        }
        let key = self
            .next_key
            .as_ref()
            .ok_or_else(|| error("epoch already published"))?;
        let certificate: DeviceCertificate = parse(recipient_certificate)?;
        let recipient = certificate
            .verify(&parse(recipient_context)?, &authority(recipient_authority)?)
            .map_err(error)?;
        json(&Offer {
            envelope: root.share_document(key, &recipient).map_err(error)?,
            membership: root
                .document_membership(
                    key,
                    &recipient,
                    if write {
                        DocumentRole::Write
                    } else {
                        DocumentRole::Read
                    },
                    self.transition.next_generation,
                )
                .map_err(error)?,
        })
    }
    pub fn preview(&self) -> Result<BrowserSync, JsValue> {
        self.session
            .as_ref()
            .ok_or_else(|| error("epoch already published"))?
            .fork_session()
    }
    pub fn held_backup(&self) -> Result<String, JsValue> {
        json(&self.held)
    }
    pub fn checkpoint(&self) -> Vec<u8> {
        self.checkpoint.clone()
    }
    pub fn transition(&self) -> Result<String, JsValue> {
        json(&self.transition)
    }
    pub fn archive(&self) -> Result<String, JsValue> {
        json(&self.archive)
    }
    /// Trusted host calls only after its durable transaction succeeds.
    pub fn publish(&mut self, vault: &mut BrowserVault) -> Result<BrowserSync, JsValue> {
        let id = self
            .previous
            .document
            .as_ref()
            .ok_or_else(|| error("invalid epoch document"))?;
        let current = vault
            .documents
            .get(id)
            .ok_or_else(|| error("original key unavailable"))?;
        if current.context() != &self.previous
            || vault.root()?.context() != &self.transition.root
            || vault.root()?.authority().map_err(error)? != self.transition.authority
            || self.session.is_none()
            || self.next_key.is_none()
        {
            return Err(error("epoch source changed; original preserved"));
        }
        let key = self
            .next_key
            .take()
            .ok_or_else(|| error("epoch already published"))?;
        vault.documents.insert(id.clone(), key);
        self.session
            .take()
            .ok_or_else(|| error("epoch already published"))
    }
}
#[wasm_bindgen]
impl BrowserVault {
    pub fn prepare_document_epoch(
        &self,
        session: &mut BrowserSync,
        consent: bool,
    ) -> Result<BrowserEpoch, JsValue> {
        self.prepare_authorized_epoch(session, None, consent)
    }
    pub fn prepare_root_document_epoch(
        &self,
        session: &mut BrowserSync,
        rotation: &str,
        consent: bool,
    ) -> Result<BrowserEpoch, JsValue> {
        self.prepare_authorized_epoch(session, Some(&parse(rotation)?), consent)
    }
}
impl BrowserVault {
    fn prepare_authorized_epoch(
        &self,
        session: &mut BrowserSync,
        rotation: Option<&RootRotation>,
        consent: bool,
    ) -> Result<BrowserEpoch, JsValue> {
        let previous = session.replica.binding().document.clone();
        let key = self
            .documents
            .get(
                previous
                    .document
                    .as_ref()
                    .ok_or_else(|| error("invalid document"))?,
            )
            .ok_or_else(|| error("document key unavailable"))?;
        if key.context() != &previous {
            return Err(error("document epoch changed"));
        }
        let next = key.rotate().map_err(error)?;
        let root = self.root()?;
        let device = root
            .certify_device(self.device.public().map_err(error)?)
            .map_err(error)?
            .verify(root.context(), &root.authority().map_err(error)?)
            .map_err(error)?;
        let generation = session
            .replica
            .binding()
            .generation
            .checked_add(1)
            .ok_or_else(|| error("generation exhausted"))?;
        let membership = root
            .document_membership(&next, &device, DocumentRole::Write, generation)
            .map_err(error)?;
        let verified = membership
            .verify(
                next.context(),
                root.context().epoch,
                &root.authority().map_err(error)?,
                generation,
            )
            .map_err(error)?;
        let prepared = match rotation {
            Some(rotation) => session.replica.prepare_root_epoch(
                root,
                rotation,
                next.fork_session(),
                &verified,
                consent,
            ),
            None => session
                .replica
                .prepare_epoch(root, next.fork_session(), &verified, consent),
        }
        .map_err(error)?;
        let mut runtime = session.runtime.clone();
        runtime
            .restore(prepared.replica.state().clone())
            .map_err(error)?;
        Ok(BrowserEpoch {
            previous,
            held: root.wrap_held_document(&next).map_err(error)?,
            next_key: Some(next),
            session: Some(BrowserSync {
                replica: prepared.replica,
                runtime,
                membership,
                roster: vec![verified],
                owner_epoch: root.context().epoch,
                authority: root.authority().map_err(error)?,
            }),
            checkpoint: prepared.checkpoint,
            transition: prepared.transition,
            archive: prepared.archive,
        })
    }
}
#[wasm_bindgen]
impl BrowserSync {
    pub fn fork_session(&self) -> Result<BrowserSync, JsValue> {
        Ok(Self {
            replica: self.replica.fork_session().map_err(error)?,
            runtime: self.runtime.clone(),
            membership: self.membership.clone(),
            roster: self.roster.clone(),
            owner_epoch: self.owner_epoch,
            authority: self.authority,
        })
    }
    pub fn activate_document_key(&self, vault: &mut BrowserVault) -> Result<(), JsValue> {
        if self.membership.device != vault.device.public().map_err(error)? {
            return Err(error("document session belongs to another device"));
        }
        let context = &self.replica.binding().document;
        let id = context
            .document
            .as_ref()
            .ok_or_else(|| error("invalid document context"))?;
        if let Some(existing) = vault.documents.get(id) {
            if existing.context().account != context.account
                || existing.context().epoch > context.epoch
            {
                return Err(error("older document key cannot replace current epoch"));
            }
        } else if vault.documents.len() >= 256 {
            return Err(error("document key limit"));
        }
        let held = self.replica.wrap_held_key(vault.root()?).map_err(error)?;
        let key = vault
            .root()?
            .unwrap_held_document(&held, context)
            .map_err(error)?;
        if let Some(existing) = vault.documents.get(id)
            && existing.context() == context
        {
            let probe = existing
                .seal(b"existing document key", b"same epoch key check")
                .map_err(error)?;
            key.open(&probe, b"same epoch key check").map_err(error)?;
        }
        vault.documents.insert(id.clone(), key);
        Ok(())
    }
    pub fn matches_epoch_cut(&self, transition: &str) -> Result<bool, JsValue> {
        self.replica
            .matches_epoch_cut(&parse(transition)?)
            .map_err(error)
    }
    pub fn matches_root_epoch_cut(
        &self,
        transition: &str,
        rotation: &str,
    ) -> Result<bool, JsValue> {
        self.replica
            .matches_root_epoch_cut(&parse(transition)?, &parse(rotation)?)
            .map_err(error)
    }
    pub fn install_epoch(
        &mut self,
        checkpoint: &[u8],
        previous_binding: &str,
    ) -> Result<String, JsValue> {
        let previous: needware_sync::Binding = parse(previous_binding)?;
        let root = KeyContext {
            version: 1,
            kind: KeyKind::AccountRoot,
            account: self.replica.binding().document.account.clone(),
            document: None,
            epoch: self.owner_epoch,
        };
        let mut candidate = self.replica.fork_session().map_err(error)?;
        let transition = candidate
            .install_epoch(
                checkpoint,
                EpochTrust {
                    previous: &previous,
                    root: &root,
                    authority: &self.authority,
                    roster: &self.roster,
                },
            )
            .map_err(error)?;
        let mut runtime = self.runtime.clone();
        runtime.restore(candidate.state().clone()).map_err(error)?;
        self.replica = candidate;
        self.runtime = runtime;
        json(&transition)
    }
    pub fn install_root_epoch(
        &mut self,
        checkpoint: &[u8],
        previous_binding: &str,
        previous_root: &str,
        previous_authority: &str,
    ) -> Result<String, JsValue> {
        let previous: needware_sync::Binding = parse(previous_binding)?;
        let old_root: KeyContext = parse(previous_root)?;
        let old_authority = authority(previous_authority)?;
        let root = KeyContext {
            version: 1,
            kind: KeyKind::AccountRoot,
            account: self.replica.binding().document.account.clone(),
            document: None,
            epoch: self.owner_epoch,
        };
        let mut candidate = self.replica.fork_session().map_err(error)?;
        let transition = candidate
            .install_root_epoch(
                checkpoint,
                RootEpochTrust {
                    epoch: EpochTrust {
                        previous: &previous,
                        root: &root,
                        authority: &self.authority,
                        roster: &self.roster,
                    },
                    previous_root: &old_root,
                    previous_authority: &old_authority,
                },
            )
            .map_err(error)?;
        let mut runtime = self.runtime.clone();
        runtime.restore(candidate.state().clone()).map_err(error)?;
        self.replica = candidate;
        self.runtime = runtime;
        json(&transition)
    }
    pub fn install_accepted_root_epoch(
        &mut self,
        checkpoint: &[u8],
        previous_binding: &str,
    ) -> Result<String, JsValue> {
        let previous: needware_sync::Binding = parse(previous_binding)?;
        let root = KeyContext {
            version: 1,
            kind: KeyKind::AccountRoot,
            account: self.replica.binding().document.account.clone(),
            document: None,
            epoch: self.owner_epoch,
        };
        let mut candidate = self.replica.fork_session().map_err(error)?;
        let transition = candidate
            .install_accepted_root_epoch(
                checkpoint,
                EpochTrust {
                    previous: &previous,
                    root: &root,
                    authority: &self.authority,
                    roster: &self.roster,
                },
            )
            .map_err(error)?;
        let mut runtime = self.runtime.clone();
        runtime.restore(candidate.state().clone()).map_err(error)?;
        self.replica = candidate;
        self.runtime = runtime;
        json(&transition)
    }
    pub fn seal_payload(&self, bytes: &[u8], metadata: &str) -> Result<Vec<u8>, JsValue> {
        self.replica
            .seal_payload(bytes, metadata.as_bytes())
            .map_err(error)
    }
    pub fn open_payload(&self, bytes: &[u8], metadata: &str) -> Result<Vec<u8>, JsValue> {
        Ok(self
            .replica
            .open_payload(bytes, metadata.as_bytes())
            .map_err(error)?
            .to_vec())
    }
}
impl BrowserSync {
    #[allow(clippy::too_many_arguments)]
    fn new(
        package: needware_package::VerifiedPackage,
        scope: Scope,
        key: DocumentKey,
        device: DeviceKeys,
        membership: DocumentMembership,
        owner_epoch: u32,
        authority: [u8; 32],
        schema_epoch: u32,
    ) -> Result<Self, JsValue> {
        let verified = membership
            .verify(
                key.context(),
                owner_epoch,
                &authority,
                membership.generation,
            )
            .map_err(error)?;
        let replica = Replica::new(
            package.application().clone(),
            scope,
            key,
            device,
            &verified,
            schema_epoch,
        )
        .map_err(error)?;
        let app = package.application().application();
        let grants = Grants {
            application: app.id.clone(),
            revision: app.revision.clone(),
            capabilities: app.capabilities.clone(),
        };
        let trusted = package.signers().to_vec();
        let runtime = needware_runtime::Runtime::load(
            package,
            Some(replica.state().clone()),
            grants,
            &trusted,
        )
        .map_err(error)?;
        Ok(Self {
            replica,
            runtime,
            membership,
            roster: vec![verified],
            owner_epoch,
            authority,
        })
    }
}
#[wasm_bindgen]
impl BrowserSync {
    pub fn binding(&self) -> Result<String, JsValue> {
        json(self.replica.binding())
    }
    pub fn membership(&self) -> Result<String, JsValue> {
        json(&self.membership)
    }
    pub fn snapshot(&self) -> Result<String, JsValue> {
        json(self.replica.state())
    }
    pub fn verify_package(&self, bytes: &[u8]) -> Result<(), JsValue> {
        let package = needware_package::verify(bytes).map_err(error)?;
        if package.digest() != self.runtime.package().digest()
            || package.signers() != self.runtime.package().signers()
        {
            return Err(error("journal package identity mismatch"));
        }
        Ok(())
    }
    pub fn restore_local_state(&mut self, state: &str) -> Result<(), JsValue> {
        let state = needware_package::parse_state(state.as_bytes()).map_err(error)?;
        let mut runtime = self.runtime.clone();
        runtime.restore(state).map_err(error)?;
        self.replica
            .restore_local_state(runtime.state().clone())
            .map_err(error)?;
        self.runtime = runtime;
        Ok(())
    }
    pub fn view(&self) -> Result<String, JsValue> {
        json(&self.runtime.view().map_err(error)?)
    }
    pub fn set_roster(&mut self, roster: &str) -> Result<(), JsValue> {
        if roster.len() > 256 * 1024 {
            return Err(error("roster size limit"));
        }
        let memberships: Vec<DocumentMembership> =
            needware_package::parse_json(roster.as_bytes()).map_err(error)?;
        if memberships.len() > 256 {
            return Err(error("member limit"));
        }
        let mut devices = BTreeSet::new();
        let mut verified = Vec::new();
        for member in memberships {
            if !devices.insert(member.device.id.clone()) {
                return Err(error("duplicate device"));
            }
            verified.push(
                member
                    .verify(
                        &self.replica.binding().document,
                        self.owner_epoch,
                        &self.authority,
                        self.replica.binding().generation,
                    )
                    .map_err(error)?,
            );
        }
        self.roster = verified;
        Ok(())
    }
    pub fn known(&self) -> Result<String, JsValue> {
        json(
            &self
                .replica
                .known()
                .iter()
                .map(|hash| hex::encode(hash.0))
                .collect::<Vec<_>>(),
        )
    }
    pub fn export(&mut self, known: &str) -> Result<String, JsValue> {
        let known: Vec<String> = needware_package::parse_json(known.as_bytes()).map_err(error)?;
        if known.len() > 100_000 {
            return Err(error("known history limit"));
        }
        let known = known
            .iter()
            .map(|hash| authority(hash).map(needware_sync::ChangeHash))
            .collect::<Result<BTreeSet<_>, _>>()?;
        json(&self.replica.export(&known).map_err(error)?)
    }
    pub fn checkpoint(&self) -> Result<String, JsValue> {
        json(&self.replica.checkpoint().map_err(error)?)
    }
    pub fn receive(&mut self, frame: &str) -> Result<usize, JsValue> {
        let frame = EncryptedFrame::parse(frame.as_bytes()).map_err(error)?;
        let received = self.replica.receive(&frame, &self.roster).map_err(error)?;
        self.runtime
            .restore(self.replica.state().clone())
            .map_err(error)?;
        Ok(received)
    }
    pub fn dispatch(&mut self, event: &str) -> Result<String, JsValue> {
        let event = needware_package::parse_json(event.as_bytes()).map_err(error)?;
        let before = self.runtime.state().clone();
        let effects = self.runtime.dispatch(&event).map_err(error)?;
        if let Err(failure) = self.replica.commit_state(self.runtime.state().clone()) {
            self.runtime.restore(before).map_err(error)?;
            return Err(error(failure));
        }
        json(&effects)
    }
}
#[wasm_bindgen]
pub fn authored_sync_example() -> Result<Vec<u8>, JsValue> {
    let mut app = needware_ir::examples::typed_habit_tracker();
    app.capabilities.push(Capability::Storage {
        synchronized: true,
        write: true,
        collections: vec!["habits".into()],
    });
    app.capabilities
        .push(Capability::Collaboration { write: true });
    needware_package::build(app, vec![], &SecretKey::random().map_err(error)?).map_err(error)
}
