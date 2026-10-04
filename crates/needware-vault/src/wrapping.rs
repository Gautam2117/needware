use super::*;
use device::Kem;
use hpke::{Deserializable, Kem as KemTrait, OpModeR, OpModeS, Serializable};
use rand_core::SeedableRng;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceEnvelope {
    pub context: KeyContext,
    pub root_epoch: u32,
    pub authority: [u8; 32],
    pub recipient: DevicePublic,
    pub encapsulated: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub signature: Vec<u8>,
}
impl DeviceEnvelope {
    fn aad(&self) -> Result<Vec<u8>> {
        canonical(
            b"NEEDWARE-HPKE-KEY\0",
            &(
                &self.context,
                self.root_epoch,
                self.authority,
                &self.recipient,
            ),
        )
    }
    fn message(&self) -> Result<Vec<u8>> {
        canonical(
            b"NEEDWARE-HPKE-ATTESTATION\0",
            &(self.aad()?, &self.encapsulated, &self.ciphertext),
        )
    }
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        decode(bytes)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WrappedKey {
    pub context: KeyContext,
    pub root_epoch: u32,
    pub authority: [u8; 32],
    pub ciphertext: Vec<u8>,
}
impl WrappedKey {
    fn aad(&self) -> Result<Vec<u8>> {
        canonical(
            b"NEEDWARE-OWNER-DOCUMENT-KEY\0",
            &(&self.context, self.root_epoch, self.authority),
        )
    }
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        decode(bytes)
    }
}
impl AccountVault {
    fn seal_device(
        &self,
        context: KeyContext,
        key: &SecretKey,
        recipient: &VerifiedDevice,
    ) -> Result<DeviceEnvelope> {
        context.validate()?;
        let mut envelope = DeviceEnvelope {
            context,
            root_epoch: self.context.epoch,
            authority: self.authority()?,
            recipient: recipient.public().clone(),
            encapsulated: vec![],
            ciphertext: vec![],
            signature: vec![],
        };
        let public = <Kem as KemTrait>::PublicKey::from_bytes(&envelope.recipient.encryption)
            .map_err(|_| VaultError::Context)?;
        let seed = SecretKey::random()?;
        let mut rng = rand_chacha::ChaCha20Rng::from_seed(*seed.bytes());
        let (encapsulated, ciphertext) = hpke::single_shot_seal_with_rng::<
            hpke::aead::ChaCha20Poly1305,
            hpke::kdf::HkdfSha256,
            Kem,
        >(
            &OpModeS::Base,
            &public,
            b"needware HPKE key transfer v1",
            key.bytes(),
            &envelope.aad()?,
            &mut rng,
        )
        .map_err(|_| VaultError::Authentication)?;
        envelope.encapsulated = encapsulated.to_bytes().to_vec();
        envelope.ciphertext = ciphertext;
        envelope.signature = self.signing()?.sign(&envelope.message()?).to_vec();
        Ok(envelope)
    }
    pub fn enroll_device(&self, recipient: &VerifiedDevice) -> Result<DeviceEnvelope> {
        if recipient.context() != &self.context
            || recipient.certificate.authority != self.authority()?
        {
            return Err(VaultError::Authentication);
        }
        self.seal_device(self.context.clone(), &self.root, recipient)
    }
    pub fn share_document(
        &self,
        key: &DocumentKey,
        recipient: &VerifiedDevice,
    ) -> Result<DeviceEnvelope> {
        if key.context.account != self.context.account {
            return Err(VaultError::Context);
        }
        self.seal_device(key.context.clone(), &key.key, recipient)
    }
    pub fn wrap_document(&self, key: &DocumentKey) -> Result<WrappedKey> {
        if key.context.account != self.context.account {
            return Err(VaultError::Context);
        }
        let mut envelope = WrappedKey {
            context: key.context.clone(),
            root_epoch: self.context.epoch,
            authority: self.authority()?,
            ciphertext: vec![],
        };
        envelope.ciphertext =
            needware_crypto::seal(&self.wrapping()?, key.key.bytes(), &envelope.aad()?)?;
        Ok(envelope)
    }
    pub fn unwrap_document(
        &self,
        envelope: &WrappedKey,
        expected: &KeyContext,
    ) -> Result<DocumentKey> {
        envelope.context.validate()?;
        expected.validate()?;
        if envelope.context != *expected
            || expected.kind != KeyKind::DocumentKey
            || expected.account != self.context.account
            || envelope.root_epoch != self.context.epoch
            || envelope.authority != self.authority()?
            || envelope.ciphertext.len() != 72
        {
            return Err(VaultError::Authentication);
        }
        let plaintext =
            needware_crypto::open(&self.wrapping()?, &envelope.ciphertext, &envelope.aad()?)
                .map_err(|_| VaultError::Authentication)?;
        Ok(DocumentKey {
            context: expected.clone(),
            key: secret(&plaintext)?,
        })
    }
}
impl DeviceKeys {
    fn open_key(
        &self,
        envelope: &DeviceEnvelope,
        expected: &KeyContext,
        root_epoch: u32,
        authority: &[u8; 32],
    ) -> Result<SecretKey> {
        envelope.context.validate()?;
        expected.validate()?;
        if envelope.context != *expected
            || envelope.root_epoch != root_epoch
            || root_epoch == 0
            || envelope.authority != *authority
            || envelope.recipient != self.public()?
            || envelope.encapsulated.len() != 32
            || envelope.ciphertext.len() != 48
            || envelope.signature.len() != 64
        {
            return Err(VaultError::Authentication);
        }
        needware_crypto::verify(
            authority,
            &envelope.message()?,
            &envelope
                .signature
                .as_slice()
                .try_into()
                .map_err(|_| VaultError::Authentication)?,
        )
        .map_err(|_| VaultError::Authentication)?;
        let encapsulated = <Kem as KemTrait>::EncappedKey::from_bytes(&envelope.encapsulated)
            .map_err(|_| VaultError::Authentication)?;
        let plaintext = zeroize::Zeroizing::new(
            hpke::single_shot_open::<hpke::aead::ChaCha20Poly1305, hpke::kdf::HkdfSha256, Kem>(
                &OpModeR::Base,
                &self.encryption()?,
                &encapsulated,
                b"needware HPKE key transfer v1",
                &envelope.ciphertext,
                &envelope.aad()?,
            )
            .map_err(|_| VaultError::Authentication)?,
        );
        secret(&plaintext)
    }
    pub fn open_account(
        &self,
        envelope: &DeviceEnvelope,
        expected: &KeyContext,
        authority: &[u8; 32],
    ) -> Result<AccountVault> {
        if expected.kind != KeyKind::AccountRoot {
            return Err(VaultError::Context);
        }
        let root = self.open_key(envelope, expected, expected.epoch, authority)?;
        let vault = AccountVault {
            context: expected.clone(),
            root,
        };
        if vault.authority()? != *authority {
            return Err(VaultError::Authentication);
        }
        Ok(vault)
    }
    pub fn open_document(
        &self,
        envelope: &DeviceEnvelope,
        expected: &KeyContext,
        owner_root_epoch: u32,
        owner_authority: &[u8; 32],
    ) -> Result<DocumentKey> {
        if expected.kind != KeyKind::DocumentKey {
            return Err(VaultError::Context);
        }
        Ok(DocumentKey {
            context: expected.clone(),
            key: self.open_key(envelope, expected, owner_root_epoch, owner_authority)?,
        })
    }
}
