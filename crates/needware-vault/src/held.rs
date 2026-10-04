use super::*;

/// A document key retained under its recipient's root, including foreign-owned documents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeldDocumentKey {
    pub document: KeyContext,
    pub holder: KeyContext,
    pub authority: [u8; 32],
    pub ciphertext: Vec<u8>,
}
impl HeldDocumentKey {
    fn aad(&self) -> Result<Vec<u8>> {
        canonical(
            b"NEEDWARE-HELD-DOCUMENT-KEY\0",
            &(&self.document, &self.holder, self.authority),
        )
    }
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        decode(bytes)
    }
}
impl AccountVault {
    pub fn wrap_held_document(&self, key: &DocumentKey) -> Result<HeldDocumentKey> {
        key.context.validate()?;
        if key.context.kind != KeyKind::DocumentKey {
            return Err(VaultError::Context);
        }
        let mut envelope = HeldDocumentKey {
            document: key.context.clone(),
            holder: self.context.clone(),
            authority: self.authority()?,
            ciphertext: vec![],
        };
        envelope.ciphertext =
            needware_crypto::seal(&self.wrapping()?, key.key.bytes(), &envelope.aad()?)?;
        Ok(envelope)
    }
    pub fn unwrap_held_document(
        &self,
        envelope: &HeldDocumentKey,
        expected: &KeyContext,
    ) -> Result<DocumentKey> {
        expected.validate()?;
        envelope.document.validate()?;
        envelope.holder.validate()?;
        if expected.kind != KeyKind::DocumentKey
            || envelope.document != *expected
            || envelope.holder != self.context
            || envelope.authority != self.authority()?
            || envelope.ciphertext.len() != 72
        {
            return Err(VaultError::Authentication);
        }
        let bytes =
            needware_crypto::open(&self.wrapping()?, &envelope.ciphertext, &envelope.aad()?)?;
        Ok(DocumentKey {
            context: expected.clone(),
            key: secret(&bytes)?,
        })
    }
}
