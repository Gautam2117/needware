use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentRole {
    Read,
    Write,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentMembership {
    pub document: KeyContext,
    pub root_epoch: u32,
    pub authority: [u8; 32],
    pub generation: u32,
    pub device: DevicePublic,
    pub role: DocumentRole,
    pub signature: Vec<u8>,
}
#[derive(Clone)]
pub struct VerifiedMembership(DocumentMembership);
impl VerifiedMembership {
    pub fn authority(&self) -> &[u8; 32] {
        &self.0.authority
    }
    pub fn root_epoch(&self) -> u32 {
        self.0.root_epoch
    }
    pub fn device(&self) -> &DevicePublic {
        &self.0.device
    }
    pub fn document(&self) -> &KeyContext {
        &self.0.document
    }
    pub fn generation(&self) -> u32 {
        self.0.generation
    }
    pub fn role(&self) -> DocumentRole {
        self.0.role
    }
}
impl DocumentMembership {
    fn message(&self) -> Result<Vec<u8>> {
        canonical(
            b"NEEDWARE-DOCUMENT-MEMBERSHIP\0",
            &(
                &self.document,
                self.root_epoch,
                self.authority,
                self.generation,
                &self.device,
                self.role,
            ),
        )
    }
    pub fn verify(
        &self,
        expected: &KeyContext,
        root_epoch: u32,
        authority: &[u8; 32],
        generation: u32,
    ) -> Result<VerifiedMembership> {
        expected.validate()?;
        self.device.validate()?;
        if expected.kind != KeyKind::DocumentKey
            || self.document != *expected
            || self.root_epoch != root_epoch
            || self.authority != *authority
            || self.generation != generation
            || generation == 0
            || self.signature.len() != 64
        {
            return Err(VaultError::Authentication);
        }
        let signature = self
            .signature
            .as_slice()
            .try_into()
            .map_err(|_| VaultError::Authentication)?;
        needware_crypto::verify(authority, &self.message()?, signature)
            .map_err(|_| VaultError::Authentication)?;
        Ok(VerifiedMembership(self.clone()))
    }
}
impl AccountVault {
    pub fn document_membership(
        &self,
        key: &DocumentKey,
        device: &VerifiedDevice,
        role: DocumentRole,
        generation: u32,
    ) -> Result<DocumentMembership> {
        if key.context.account != self.context.account || generation == 0 {
            return Err(VaultError::Context);
        }
        let mut grant = DocumentMembership {
            document: key.context.clone(),
            root_epoch: self.context.epoch,
            authority: self.authority()?,
            generation,
            device: device.public().clone(),
            role,
            signature: vec![],
        };
        grant.signature = self.signing()?.sign(&grant.message()?).to_vec();
        Ok(grant)
    }
}
