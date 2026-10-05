//! Client-owned encryption hierarchy. This crate never gives the service a root secret.
mod device;
mod document_transition;
mod generation;
mod held;
mod membership;
mod operation;
mod recovery;
mod rotation;
mod wrapping;
pub use device::{DeviceCertificate, DeviceKeys, DevicePublic, VerifiedDevice};
pub use document_transition::{DocumentTransition, TransitionDigests};
pub use generation::{
    GenerationContext, GenerationEnvelope, GenerationMetadata, seal_generation_result,
};
pub use held::HeldDocumentKey;
pub use membership::{DocumentMembership, DocumentRole, VerifiedMembership};
use needware_crypto::{CryptoError, SecretKey};
pub use operation::{AccountOperation, AccountOperationKind};
pub use recovery::{RecoveryCode, RecoveryEnvelope};
pub use rotation::{RootRotation, RootTransition, VerifiedAuthority};
use serde::{Deserialize, Serialize};
use thiserror::Error;
pub use wrapping::{DeviceEnvelope, WrappedKey};

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("invalid vault context or envelope")]
    Context,
    #[error("vault authentication or decryption failed")]
    Authentication,
    #[error("invalid recovery code")]
    Recovery,
    #[error("vault cryptographic operation failed")]
    Crypto(#[from] CryptoError),
}
type Result<T> = std::result::Result<T, VaultError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyKind {
    AccountRoot,
    DocumentKey,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyContext {
    pub version: u16,
    pub kind: KeyKind,
    pub account: String,
    pub document: Option<String>,
    pub epoch: u32,
}
impl KeyContext {
    pub fn validate(&self) -> Result<()> {
        id(&self.account)?;
        if self.version != 1 || self.epoch == 0 {
            return Err(VaultError::Context);
        }
        match (&self.kind, &self.document) {
            (KeyKind::AccountRoot, None) => Ok(()),
            (KeyKind::DocumentKey, Some(document)) => id(document),
            _ => Err(VaultError::Context),
        }
    }
}
pub(crate) fn id(value: &str) -> Result<()> {
    if uuid::Uuid::parse_str(value).is_ok_and(|u| u.to_string() == value) {
        Ok(())
    } else {
        Err(VaultError::Context)
    }
}
pub(crate) fn canonical(domain: &[u8], value: &impl Serialize) -> Result<Vec<u8>> {
    let mut out = domain.to_vec();
    out.extend(serde_json_canonicalizer::to_vec(value).map_err(|_| VaultError::Context)?);
    Ok(out)
}
pub(crate) fn secret(bytes: &[u8]) -> Result<SecretKey> {
    Ok(SecretKey::from_bytes(
        bytes.try_into().map_err(|_| VaultError::Authentication)?,
    ))
}
pub(crate) fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    if bytes.len() > 8192 {
        return Err(VaultError::Context);
    }
    serde_json::from_slice(bytes).map_err(|_| VaultError::Context)
}

/// No Debug, Clone or serialization implementation for plaintext account roots.
pub struct AccountVault {
    context: KeyContext,
    root: SecretKey,
}
impl AccountVault {
    pub fn create(account: &str) -> Result<Self> {
        id(account)?;
        Ok(Self {
            context: KeyContext {
                version: 1,
                kind: KeyKind::AccountRoot,
                account: account.into(),
                document: None,
                epoch: 1,
            },
            root: SecretKey::random()?,
        })
    }
    pub fn context(&self) -> &KeyContext {
        &self.context
    }
    pub fn authority(&self) -> Result<[u8; 32]> {
        Ok(self.signing()?.public_key())
    }
    pub(crate) fn signing(&self) -> Result<SecretKey> {
        Ok(self.root.derive(b"needware account authority v1")?)
    }
    pub(crate) fn wrapping(&self) -> Result<SecretKey> {
        Ok(self.root.derive(b"needware account wrapping v1")?)
    }
    /// Fresh independent root; enrollment, recovery and document wraps must be replaced.
    pub fn rotate(&self) -> Result<Self> {
        let mut context = self.context.clone();
        context.epoch = context.epoch.checked_add(1).ok_or(VaultError::Context)?;
        Ok(Self {
            context,
            root: SecretKey::random()?,
        })
    }
    pub fn create_document(&self, document: &str) -> Result<DocumentKey> {
        id(document)?;
        Ok(DocumentKey {
            context: KeyContext {
                version: 1,
                kind: KeyKind::DocumentKey,
                account: self.context.account.clone(),
                document: Some(document.into()),
                epoch: 1,
            },
            key: SecretKey::random()?,
        })
    }
}
pub struct DocumentKey {
    context: KeyContext,
    key: SecretKey,
}
impl DocumentKey {
    /// Explicit opaque session copy for staging; secret material never crosses a host boundary.
    pub fn fork_session(&self) -> Self {
        Self {
            context: self.context.clone(),
            key: SecretKey::from_bytes(*self.key.bytes()),
        }
    }
    pub fn context(&self) -> &KeyContext {
        &self.context
    }
    /// A revoked peer cannot derive this fresh future epoch from the prior key.
    pub fn rotate(&self) -> Result<Self> {
        let mut context = self.context.clone();
        context.epoch = context.epoch.checked_add(1).ok_or(VaultError::Context)?;
        Ok(Self {
            context,
            key: SecretKey::random()?,
        })
    }
    /// Ciphertext only; context and bounded caller metadata are authenticated.
    pub fn seal(&self, bytes: &[u8], metadata: &[u8]) -> Result<Vec<u8>> {
        if bytes.len() > 32 * 1024 * 1024 || metadata.len() > 1024 {
            return Err(VaultError::Context);
        }
        let aad = canonical(
            b"NEEDWARE-DOCUMENT-PAYLOAD\0",
            &(&self.context, hex::encode(metadata)),
        )?;
        Ok(needware_crypto::seal(
            &self.key.derive(b"needware document payload v1")?,
            bytes,
            &aad,
        )?)
    }
    pub fn open(&self, bytes: &[u8], metadata: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>> {
        if bytes.len() < 40 || bytes.len() > 32 * 1024 * 1024 + 40 || metadata.len() > 1024 {
            return Err(VaultError::Context);
        }
        let aad = canonical(
            b"NEEDWARE-DOCUMENT-PAYLOAD\0",
            &(&self.context, hex::encode(metadata)),
        )?;
        needware_crypto::open(
            &self.key.derive(b"needware document payload v1")?,
            bytes,
            &aad,
        )
        .map_err(|_| VaultError::Authentication)
    }
}
