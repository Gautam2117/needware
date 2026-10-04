use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountOperationKind {
    CreateVault,
    RegisterDevice,
    RelayDocument,
}

/// Device possession proof; the service independently expires and consumes its nonce.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountOperation {
    pub certificate: DeviceCertificate,
    pub nonce: String,
    pub operation: AccountOperationKind,
    pub digest: [u8; 32],
    pub signature: Vec<u8>,
}
impl AccountOperation {
    fn message(&self) -> Result<Vec<u8>> {
        canonical(
            b"NEEDWARE-ACCOUNT-OPERATION\0",
            &(
                &self.certificate.context,
                &self.certificate.device,
                &self.nonce,
                &self.operation,
                self.digest,
            ),
        )
    }
    pub fn verify(
        &self,
        expected: &KeyContext,
        authority: &[u8; 32],
        nonce: &str,
        operation: &AccountOperationKind,
        digest: &[u8; 32],
    ) -> Result<VerifiedDevice> {
        id(&self.nonce)?;
        let verified = self.certificate.verify(expected, authority)?;
        if self.nonce != nonce || self.operation != *operation || self.digest != *digest {
            return Err(VaultError::Authentication);
        }
        needware_crypto::verify(
            &verified.public().signing,
            &self.message()?,
            &self
                .signature
                .as_slice()
                .try_into()
                .map_err(|_| VaultError::Authentication)?,
        )
        .map_err(|_| VaultError::Authentication)?;
        Ok(verified)
    }
}
impl DeviceKeys {
    pub fn account_operation(
        &self,
        verified: &VerifiedDevice,
        nonce: &str,
        operation: AccountOperationKind,
        digest: [u8; 32],
    ) -> Result<AccountOperation> {
        id(nonce)?;
        if verified.public() != &self.public()? {
            return Err(VaultError::Authentication);
        }
        let mut proof = AccountOperation {
            certificate: verified.certificate.clone(),
            nonce: nonce.into(),
            operation,
            digest,
            signature: vec![],
        };
        proof.signature = self.sign(&proof.message()?)?.to_vec();
        Ok(proof)
    }
}
