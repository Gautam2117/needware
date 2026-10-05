use super::*;
use device::Kem;
use hpke::{Deserializable, Kem as KemTrait, OpModeR, OpModeS, Serializable};
use rand_core::SeedableRng;
pub const MAX_GENERATION_BYTES: usize = 4 * 1024 * 1024;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenerationContext {
    pub version: u16,
    pub account: String,
    pub job: String,
}
impl GenerationContext {
    fn validate(&self) -> Result<()> {
        id(&self.account)?;
        id(&self.job)?;
        if self.version != 1 {
            return Err(VaultError::Context);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenerationMetadata {
    pub context: GenerationContext,
    pub recipient: DevicePublic,
    pub bytes: u32,
    pub digest: [u8; 32],
    pub encapsulated: [u8; 32],
}
impl GenerationMetadata {
    fn aad(&self) -> Result<Vec<u8>> {
        self.context.validate()?;
        self.recipient.validate()?;
        if self.bytes == 0 || self.bytes as usize > MAX_GENERATION_BYTES {
            return Err(VaultError::Context);
        }
        canonical(
            b"NEEDWARE-GENERATION-RESULT\0",
            &(&self.context, &self.recipient, self.bytes, self.digest),
        )
    }
}
pub struct GenerationEnvelope {
    pub metadata: GenerationMetadata,
    pub ciphertext: Vec<u8>,
}
/// The service receives only a registered recipient's public key. No root/device secret enters this operation.
pub fn seal_generation_result(
    context: GenerationContext,
    recipient: DevicePublic,
    plaintext: &[u8],
) -> Result<GenerationEnvelope> {
    if plaintext.is_empty() || plaintext.len() > MAX_GENERATION_BYTES {
        return Err(VaultError::Context);
    }
    let mut metadata = GenerationMetadata {
        context,
        recipient,
        bytes: plaintext.len() as u32,
        digest: needware_crypto::digest(plaintext),
        encapsulated: [0; 32],
    };
    let aad = metadata.aad()?;
    let public = <Kem as KemTrait>::PublicKey::from_bytes(&metadata.recipient.encryption)
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
        b"needware hosted generation result v1",
        plaintext,
        &aad,
        &mut rng,
    )
    .map_err(|_| VaultError::Authentication)?;
    metadata.encapsulated = encapsulated
        .to_bytes()
        .as_slice()
        .try_into()
        .map_err(|_| VaultError::Authentication)?;
    Ok(GenerationEnvelope {
        metadata,
        ciphertext,
    })
}
impl DeviceKeys {
    pub fn open_generation_result(
        &self,
        envelope: &GenerationEnvelope,
        expected: &GenerationContext,
    ) -> Result<zeroize::Zeroizing<Vec<u8>>> {
        expected.validate()?;
        let metadata = &envelope.metadata;
        let aad = metadata.aad()?;
        if metadata.context != *expected
            || metadata.recipient != self.public()?
            || envelope.ciphertext.len() != metadata.bytes as usize + 16
        {
            return Err(VaultError::Authentication);
        }
        let encapsulated = <Kem as KemTrait>::EncappedKey::from_bytes(&metadata.encapsulated)
            .map_err(|_| VaultError::Authentication)?;
        let plaintext = zeroize::Zeroizing::new(
            hpke::single_shot_open::<hpke::aead::ChaCha20Poly1305, hpke::kdf::HkdfSha256, Kem>(
                &OpModeR::Base,
                &self.encryption()?,
                &encapsulated,
                b"needware hosted generation result v1",
                &envelope.ciphertext,
                &aad,
            )
            .map_err(|_| VaultError::Authentication)?,
        );
        if plaintext.len() != metadata.bytes as usize
            || needware_crypto::digest(&plaintext) != metadata.digest
        {
            return Err(VaultError::Authentication);
        }
        Ok(plaintext)
    }
}
