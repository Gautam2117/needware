//! Opaque keys live in Rust handles owned by the trusted browser host, never the app frame.
mod local;
use super::error;
use needware_capabilities::{Capability, Grants};
use needware_crypto::SecretKey;
use needware_sync::{EncryptedFrame, Replica, Scope};
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
    pub fn restore_document_key(
        &mut self,
        backup: &str,
        expected_document: &str,
    ) -> Result<(), JsValue> {
        let context: KeyContext = parse(expected_document)?;
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
                .document_membership(key, &recipient, role, 1)
                .map_err(error)?,
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn join_document(
        &self,
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
        BrowserSync::new(
            package,
            scope,
            key,
            copy_device(&self.device)?,
            offer.membership,
            owner_root_epoch,
            pin,
            schema_epoch,
        )
    }
}
fn check_scope(app: &needware_ir::Application, scope: &Scope, write: bool) -> Result<(), JsValue> {
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
    pub fn view(&self) -> Result<String, JsValue> {
        json(&self.runtime.view().map_err(error)?)
    }
    pub fn set_roster(&mut self, roster: &str) -> Result<(), JsValue> {
        let memberships: Vec<DocumentMembership> = parse(roster)?;
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
