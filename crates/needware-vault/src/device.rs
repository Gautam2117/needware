use super::*;
use hpke::{Kem as KemTrait, Serializable};
pub(crate) type Kem = hpke::kem::X25519HkdfSha256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevicePublic {
    pub id: String,
    pub encryption: [u8; 32],
    pub signing: [u8; 32],
}
impl DevicePublic {
    pub fn validate(&self) -> Result<()> {
        id(&self.id)?;
        if self.encryption == [0; 32] || self.signing == [0; 32] {
            return Err(VaultError::Context);
        }
        Ok(())
    }
}
pub struct DeviceKeys {
    pub(crate) id: String,
    pub(crate) seed: SecretKey,
}
impl DeviceKeys {
    pub fn create() -> Result<Self> {
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            seed: SecretKey::random()?,
        })
    }
    pub(crate) fn encryption(&self) -> Result<<Kem as KemTrait>::PrivateKey> {
        let seed = self.seed.derive(b"needware device HPKE v1")?;
        Ok(Kem::derive_keypair(seed.bytes()).0)
    }
    pub fn public(&self) -> Result<DevicePublic> {
        let encryption = Kem::sk_to_pk(&self.encryption()?);
        Ok(DevicePublic {
            id: self.id.clone(),
            encryption: encryption
                .to_bytes()
                .as_slice()
                .try_into()
                .map_err(|_| VaultError::Context)?,
            signing: self
                .seed
                .derive(b"needware device signing v1")?
                .public_key(),
        })
    }
    pub fn sign(&self, message: &[u8]) -> Result<[u8; 64]> {
        if message.len() > 1024 * 1024 {
            return Err(VaultError::Context);
        }
        Ok(self
            .seed
            .derive(b"needware device signing v1")?
            .sign(message))
    }
    /// Host-held local lock keys are separate from server login/password credentials.
    pub fn lock_local(&self, lock: &SecretKey) -> Result<Vec<u8>> {
        let aad = canonical(b"NEEDWARE-LOCAL-DEVICE\0", &(1_u16, &self.id))?;
        Ok(needware_crypto::seal(
            &lock.derive(b"needware local device lock v1")?,
            self.seed.bytes(),
            &aad,
        )?)
    }
    pub fn unlock_local(device_id: &str, bytes: &[u8], lock: &SecretKey) -> Result<Self> {
        id(device_id)?;
        if bytes.len() != 72 {
            return Err(VaultError::Context);
        }
        let aad = canonical(b"NEEDWARE-LOCAL-DEVICE\0", &(1_u16, device_id))?;
        let plaintext =
            needware_crypto::open(&lock.derive(b"needware local device lock v1")?, bytes, &aad)
                .map_err(|_| VaultError::Authentication)?;
        Ok(Self {
            id: device_id.into(),
            seed: secret(&plaintext)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceCertificate {
    pub context: KeyContext,
    pub device: DevicePublic,
    pub authority: [u8; 32],
    pub signature: Vec<u8>,
}
pub struct VerifiedDevice {
    pub(crate) certificate: DeviceCertificate,
}
impl VerifiedDevice {
    pub fn public(&self) -> &DevicePublic {
        &self.certificate.device
    }
    pub fn context(&self) -> &KeyContext {
        &self.certificate.context
    }
}
impl DeviceCertificate {
    fn message(&self) -> Result<Vec<u8>> {
        canonical(
            b"NEEDWARE-DEVICE-CERTIFICATE\0",
            &(&self.context, &self.device, self.authority),
        )
    }
    pub fn verify(&self, expected: &KeyContext, authority: &[u8; 32]) -> Result<VerifiedDevice> {
        self.context.validate()?;
        self.device.validate()?;
        expected.validate()?;
        if self.context.kind != KeyKind::AccountRoot
            || self.context != *expected
            || self.authority != *authority
            || self.signature.len() != 64
        {
            return Err(VaultError::Authentication);
        }
        needware_crypto::verify(
            authority,
            &self.message()?,
            &self
                .signature
                .as_slice()
                .try_into()
                .map_err(|_| VaultError::Authentication)?,
        )
        .map_err(|_| VaultError::Authentication)?;
        Ok(VerifiedDevice {
            certificate: self.clone(),
        })
    }
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        decode(bytes)
    }
}
impl AccountVault {
    pub fn certify_device(&self, device: DevicePublic) -> Result<DeviceCertificate> {
        device.validate()?;
        let mut certificate = DeviceCertificate {
            context: self.context.clone(),
            device,
            authority: self.authority()?,
            signature: vec![],
        };
        certificate.signature = self.signing()?.sign(&certificate.message()?).to_vec();
        Ok(certificate)
    }
}
