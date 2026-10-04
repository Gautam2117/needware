use super::*;
use zeroize::Zeroizing;

/// Random 256-bit user-held secret. The checksum detects transcription mistakes.
pub struct RecoveryCode(SecretKey);
impl RecoveryCode {
    pub fn create() -> Result<Self> {
        Ok(Self(SecretKey::random()?))
    }
    pub fn export(&self) -> Zeroizing<String> {
        let mut input = Zeroizing::new(b"NEEDWARE-RECOVERY-CODE\0".to_vec());
        input.extend(self.0.bytes());
        let checksum = needware_crypto::digest(&input);
        Zeroizing::new(format!(
            "NW1-{}-{}",
            hex::encode(self.0.bytes()),
            hex::encode(&checksum[..4])
        ))
    }
    pub fn parse(text: &str) -> Result<Self> {
        if text.len() != 77
            || !text.starts_with("NW1-")
            || text.as_bytes()[68] != b'-'
            || !text[4..68]
                .bytes()
                .chain(text[69..].bytes())
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(VaultError::Recovery);
        }
        let bytes = Zeroizing::new(hex::decode(&text[4..68]).map_err(|_| VaultError::Recovery)?);
        let code = Self(secret(&bytes)?);
        if code.export().as_str() != text {
            return Err(VaultError::Recovery);
        }
        Ok(code)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryEnvelope {
    pub context: KeyContext,
    pub authority: [u8; 32],
    pub ciphertext: Vec<u8>,
}
impl RecoveryEnvelope {
    fn aad(&self) -> Result<Vec<u8>> {
        canonical(
            b"NEEDWARE-RECOVERY-ROOT\0",
            &(&self.context, self.authority),
        )
    }
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        decode(bytes)
    }
}
impl AccountVault {
    pub fn recovery_envelope(&self, code: &RecoveryCode) -> Result<RecoveryEnvelope> {
        let mut envelope = RecoveryEnvelope {
            context: self.context.clone(),
            authority: self.authority()?,
            ciphertext: vec![],
        };
        let aad = envelope.aad()?;
        envelope.ciphertext =
            needware_crypto::seal(&code.0.derive(&aad)?, self.root.bytes(), &aad)?;
        Ok(envelope)
    }
    pub fn recover(
        code: &RecoveryCode,
        envelope: &RecoveryEnvelope,
        expected: &KeyContext,
    ) -> Result<Self> {
        expected.validate()?;
        envelope.context.validate()?;
        if expected.kind != KeyKind::AccountRoot
            || envelope.context != *expected
            || envelope.ciphertext.len() != 72
        {
            return Err(VaultError::Authentication);
        }
        let aad = envelope.aad()?;
        let root = needware_crypto::open(&code.0.derive(&aad)?, &envelope.ciphertext, &aad)
            .map_err(|_| VaultError::Authentication)?;
        let vault = Self {
            context: expected.clone(),
            root: secret(&root)?,
        };
        if vault.authority()? != envelope.authority {
            return Err(VaultError::Authentication);
        }
        Ok(vault)
    }
}
